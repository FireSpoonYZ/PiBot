// Bot 电脑全屏视图（Grok Bot 风格）：全屏深色展示该 Bot 的虚拟工作屏幕。
// 顶部为返回按钮、Bot 头像与名称、右上角状态/帮助按钮；中央为全幅画面；右下角为「接管控制」胶囊按钮。
// 原生接管先中断当前对话；RPC 接管由服务端处理中断与执行器停止。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronLeft, CircleHelp, Monitor, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { ShowerTarget } from '../../host-core/index.js';
import { ConfirmDialog, Dialog } from './components/ui';
import { useExternalOverlayPresent } from './components/ui/Overlay';
import { GrokBotAvatar, type GrokAvatarPreset } from './GrokBotAvatar';
import { BotHost } from './native';
import { resolveScreenClient, type ScreenViewState, type ScreenViewer } from './screen';
import type { ShowerCall } from './ShowerPreview';
import { ErrorNotice, errorText, useText } from './ui';

/** 页面转场动画结束后再贴原生画面，避免动画过程中原生 TextureView 位置跳动。 */
const SETTLE_MS = 280;
const POLL_MS = 800;
const STAGE_RADIUS = 0;
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1920;
const SWIPE_THRESHOLD_PX = 18;
const MIN_SWIPE_DURATION_MS = 120;
const MAX_SWIPE_DURATION_MS = 1200;

const RPC_KEY_MAP: Record<string, string> = {
  Enter: 'ENTER',
  Backspace: 'BACKSPACE',
  Delete: 'DELETE',
  Escape: 'ESCAPE',
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

interface RpcStatusSnapshot {
  live: boolean;
  userControl: boolean;
  width: number;
  height: number;
  sessionId: string;
  phase: 'none' | 'connecting' | 'authentication-required' | 'live' | 'ended' | 'unavailable' | 'error';
  message?: string;
}

export type BotScreenPanelProps = {
  botId: string;
  botName: string;
  hostLabel: string;
  avatarPreset: GrokAvatarPreset;
  isPrimary?: boolean;
  hostKind: 'local' | 'remote';
  open: boolean;
  onBack(): void;
  /** 中断该 Bot 当前对话（已有 interrupt/abort）；失败不阻止执行器侧接管。 */
  onInterrupt(): Promise<void>;
  /** 非原生覆盖层环境（如远程节点或 Web 预览）使用的 RPC 调用桥与目标。 */
  showerTarget?: ShowerTarget | null;
  showerCall?: ShowerCall;
  showerConnected?: boolean;
};

export function BotScreenPanel({
  botId,
  botName,
  hostLabel,
  avatarPreset,
  isPrimary,
  hostKind,
  open,
  onBack,
  onInterrupt,
  showerTarget,
  showerCall,
  showerConnected = true,
}: BotScreenPanelProps) {
  const t = useText();
  const resolution = useMemo(() => resolveScreenClient({ botId, hostKind }), [botId, hostKind]);
  const isNativeClient = resolution.kind === 'client';

  const rpcCall = useMemo<ShowerCall | null>(() => {
    if (hostKind === 'remote') return showerCall ?? null;
    return async (method, params) => (await BotHost.call({ method, params })).result;
  }, [hostKind, showerCall]);

  const baseParams = useMemo<Record<string, unknown> | null>(() => {
    if (!showerTarget || !showerTarget.botId) return null;
    const p: Record<string, unknown> = { botId: showerTarget.botId };
    if (showerTarget.scopeId) p.scopeId = showerTarget.scopeId;
    return p;
  }, [showerTarget]);

  const canUseRpcFallback = Boolean(!isNativeClient && baseParams && rpcCall && showerConnected);
  const canControlSession = Boolean(baseParams && rpcCall && showerConnected && botId && !botId.startsWith('__'));

  const [state, setState] = useState<ScreenViewState | null>(null);
  const [rpcState, setRpcState] = useState<RpcStatusSnapshot | null>(null);
  const [rpcFrameSrc, setRpcFrameSrc] = useState('');
  const rpcGenRef = useRef(0);
  const rpcInFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [releaseConfirmOpen, setReleaseConfirmOpen] = useState(false);
  const [releaseError, setReleaseError] = useState('');

  const screenRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const viewerRef = useRef<ScreenViewer | null>(null);
  const settledRef = useRef(false);
  const externalOverlayVisible = useExternalOverlayPresent(open && isNativeClient, screenRef);
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  const releaseConfirmOpenRef = useRef(releaseConfirmOpen);
  releaseConfirmOpenRef.current = releaseConfirmOpen;
  const hasError = Boolean(error);
  const hasErrorRef = useRef(hasError);
  hasErrorRef.current = hasError;
  const externalOverlayVisibleRef = useRef(externalOverlayVisible);
  externalOverlayVisibleRef.current = externalOverlayVisible;
  const gestureStartRef = useRef<{ x: number; y: number; at: number; pointerId: number } | null>(null);

  const pushLayout = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const rect = stageRef.current?.getBoundingClientRect();
    // 任意弹窗、确认框、错误条、外部弹层或全局通知可见时隐藏原生 TextureView，避免遮挡 HTML UI。
    const overlayBlocking =
      helpOpenRef.current ||
      releaseConfirmOpenRef.current ||
      hasErrorRef.current ||
      externalOverlayVisibleRef.current;
    const visible = settledRef.current && !overlayBlocking && !!rect && rect.width > 0 && rect.height > 0;
    const viewport = visible && rect
      ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height, radius: STAGE_RADIUS }
      : null;
    viewer.layout(viewport).then(next => {
      if (viewerRef.current === viewer) setState(next);
    }).catch(() => {});
  }, []);

  // 原生客户端模式：连接并轮询状态；关闭页面不销毁虚拟屏幕。
  useEffect(() => {
    setState(null);
    setError('');
    if (!open || resolution.kind !== 'client') return;
    let alive = true;
    let opened: ScreenViewer | null = null;
    resolution.client.open(botId).then(viewer => {
      if (!alive) {
        void viewer.close().catch(() => {});
        return;
      }
      opened = viewer;
      viewerRef.current = viewer;
      pushLayout();
    }).catch(failure => {
      if (alive) setError(errorText(failure));
    });
    const poll = window.setInterval(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.status().then(next => {
        if (alive && viewerRef.current === viewer) setState(next);
      }).catch(() => {});
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(poll);
      viewerRef.current = null;
      if (opened) void opened.close().catch(() => {});
    };
  }, [open, botId, resolution, pushLayout]);

  const lastSessionIdRef = useRef<string>('');
  const takeoverSessionIdRef = useRef<string>('');

  // RPC 画面回退模式（远程节点或非 Tauri WebView）：轮询 getShowerStatus 与 getShowerFrame。
  // 单飞 + 世代围栏：在途请求未完成时新 tick 直接跳过；effect 清理后旧轮询结果不得覆盖新状态。
  // force（显式控制/输入后的刷新）推进世代使旧在途返回失效，不被单飞跳过。
  const refreshRpcStatus = useCallback(async (force = false) => {
    if (!canUseRpcFallback || !rpcCall || !baseParams) return;
    if (force) rpcGenRef.current += 1;
    else if (rpcInFlightRef.current) return;
    const gen = rpcGenRef.current;
    rpcInFlightRef.current = true;
    try {
      const raw = (await rpcCall('getShowerStatus', baseParams)) as Record<string, unknown> | null;
      const sessPhase = typeof raw?.phase === 'string' ? raw.phase : '';
      const sessionId = typeof raw?.sessionId === 'string' ? raw.sessionId : '';
      if (rpcGenRef.current !== gen) return;
      // 会话结束或换了 sessionId 时先清掉旧帧与旧会话引用，避免短暂显示上一会话画面。
      const sessionChanged = sessionId !== lastSessionIdRef.current;
      const live = sessPhase === 'ready';
      if (!live || sessionChanged) {
        setRpcFrameSrc('');
        takeoverSessionIdRef.current = '';
      }
      lastSessionIdRef.current = sessionId;
      const width = typeof raw?.width === 'number' && raw.width > 0 ? raw.width : DEFAULT_WIDTH;
      const height = typeof raw?.height === 'number' && raw.height > 0 ? raw.height : DEFAULT_HEIGHT;
      const userControl = Boolean(sessionId && takeoverSessionIdRef.current === sessionId);
      const phase: RpcStatusSnapshot['phase'] =
        sessPhase === 'ready'
          ? 'live'
          : sessPhase === 'authentication-required'
            ? 'authentication-required'
            : sessPhase === 'starting'
              ? 'connecting'
              : sessPhase === 'closed'
                ? 'ended'
                : sessPhase === 'error'
                  ? 'error'
                  : sessPhase === 'unavailable'
                    ? 'unavailable'
                    : 'none';
      const errObj = raw && typeof raw.error === 'object' && raw.error ? (raw.error as Record<string, unknown>) : null;
      const message = typeof errObj?.message === 'string' ? errObj.message : undefined;
      setRpcState({ live, userControl, width, height, sessionId, phase, message });

      if (live && sessionId) {
        const frameRes = (await rpcCall('getShowerFrame', {
          ...baseParams,
          sessionId,
        })) as Record<string, unknown> | null;
        if (rpcGenRef.current !== gen) return;
        if (frameRes && typeof frameRes.data === 'string' && frameRes.data) {
          const mime = typeof frameRes.mimeType === 'string' && frameRes.mimeType ? frameRes.mimeType : 'image/png';
          setRpcFrameSrc(`data:${mime};base64,${frameRes.data}`);
        }
      }
    } catch (failure) {
      if (rpcGenRef.current !== gen) return;
      // 会话到期被 manager 释放后，已排队的 getFrame 会返回该码：视为正常空闲，不显示红字错误。
      if ((failure as { code?: string })?.code === 'SHOWER_SESSION_NOT_FOUND') {
        lastSessionIdRef.current = '';
        takeoverSessionIdRef.current = '';
        setRpcFrameSrc('');
        setRpcState(prev => ({
          live: false,
          userControl: false,
          width: prev?.width ?? DEFAULT_WIDTH,
          height: prev?.height ?? DEFAULT_HEIGHT,
          sessionId: '',
          phase: 'none',
        }));
        return;
      }
      setRpcState(prev => ({
        live: false,
        userControl: false,
        width: prev?.width ?? DEFAULT_WIDTH,
        height: prev?.height ?? DEFAULT_HEIGHT,
        sessionId: prev?.sessionId ?? '',
        phase: 'error',
        message: errorText(failure),
      }));
    } finally {
      // 世代已变（effect 重跑或 force 刷新）时本趟返回已失效，不得解除新一趟的单飞。
      if (rpcGenRef.current === gen) rpcInFlightRef.current = false;
    }
  }, [canUseRpcFallback, rpcCall, baseParams]);

  useEffect(() => {
    rpcGenRef.current += 1;
    rpcInFlightRef.current = false;
    lastSessionIdRef.current = '';
    takeoverSessionIdRef.current = '';
    setRpcState(null);
    setRpcFrameSrc('');
    if (!open || !canUseRpcFallback) return;
    void refreshRpcStatus();
    const poll = window.setInterval(() => {
      void refreshRpcStatus();
    }, POLL_MS);
    return () => {
      rpcGenRef.current += 1;
      lastSessionIdRef.current = '';
      takeoverSessionIdRef.current = '';
      window.clearInterval(poll);
    };
  }, [open, canUseRpcFallback, refreshRpcStatus]);

  // 动画期间隐藏原生画面，稳定后再按占位元素位置贴上。
  useEffect(() => {
    settledRef.current = false;
    pushLayout();
    if (!open) return;
    const timer = window.setTimeout(() => {
      settledRef.current = true;
      pushLayout();
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open, pushLayout]);

  useEffect(() => {
    pushLayout();
  }, [helpOpen, releaseConfirmOpen, hasError, externalOverlayVisible, pushLayout]);

  useEffect(() => {
    if (!open) {
      setHelpOpen(false);
      setReleaseConfirmOpen(false);
      setReleaseError('');
    }
  }, [open]);

  // 全屏打开时聚焦返回按钮，关闭时如原触发元素仍在文档中则还原焦点。
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = window.requestAnimationFrame(() => {
      (backBtnRef.current ?? helpBtnRef.current)?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      if (previousFocus && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !open) return;
    const observer = new ResizeObserver(() => pushLayout());
    observer.observe(stage);
    window.addEventListener('resize', pushLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', pushLayout);
    };
  }, [open, pushLayout]);

  const resolveCurrentSessionId = async (): Promise<string> => {
    if (rpcState?.sessionId) return rpcState.sessionId;
    if (lastSessionIdRef.current) return lastSessionIdRef.current;
    if (rpcCall && baseParams) {
      const raw = (await rpcCall('getShowerStatus', baseParams)) as Record<string, unknown> | null;
      const sid = typeof raw?.sessionId === 'string' ? raw.sessionId : '';
      if (sid) lastSessionIdRef.current = sid;
      return sid;
    }
    return '';
  };

  const takeover = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (isNativeClient) {
        try {
          await onInterrupt();
        } catch (failure) {
          setError(t('中断对话失败：', 'Interrupt failed: ') + errorText(failure));
        }
        const viewer = viewerRef.current;
        if (!viewer) return;
        const next = await viewer.takeover();
        if (viewerRef.current === viewer) setState(next);
      } else if (canUseRpcFallback && rpcCall && baseParams) {
        const sid = await resolveCurrentSessionId();
        if (!sid) throw new Error(t('还没有活跃的虚拟屏幕会话', 'No active virtual screen session'));
        await rpcCall('takeoverShower', {
          ...baseParams,
          sessionId: sid,
        });
        takeoverSessionIdRef.current = sid;
        await refreshRpcStatus(true);
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateRpcScreen = async () => {
    if (!canControlSession || !rpcCall || !baseParams || busy) return;
    setBusy(true);
    setError('');
    try {
      if (hostKind === 'local') {
        await BotHost.start().catch(() => {});
        for (let i = 0; i < 15; i++) {
          const st = await BotHost.status().catch(() => null);
          if (st?.phase === 'running') break;
          await new Promise(r => setTimeout(r, 350));
        }
      }
      const created = (await rpcCall('createShowerSession', {
        ...baseParams,
        input: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
      })) as Record<string, unknown> | null;
      if (typeof created?.sessionId === 'string' && created.sessionId) {
        lastSessionIdRef.current = created.sessionId;
      }
      if (isNativeClient) {
        const viewer = viewerRef.current;
        if (viewer) {
          const next = await viewer.status().catch(() => null);
          if (next && viewerRef.current === viewer) setState(next);
        }
        pushLayout();
      } else {
        await refreshRpcStatus(true);
      }
      setHelpOpen(false);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const handleReleaseRpcScreen = async () => {
    if (!canControlSession || !rpcCall || !baseParams || busy) return;
    setBusy(true);
    setError('');
    setReleaseError('');
    try {
      const sid = await resolveCurrentSessionId();
      if (sid) {
        await rpcCall('releaseShowerSession', {
          ...baseParams,
          sessionId: sid,
        });
      }
      lastSessionIdRef.current = '';
      takeoverSessionIdRef.current = '';
      setRpcFrameSrc('');
      if (isNativeClient) {
        const viewer = viewerRef.current;
        if (viewer) {
          const next = await viewer.status().catch(() => null);
          if (next && viewerRef.current === viewer) setState(next);
        }
        pushLayout();
      } else {
        await refreshRpcStatus(true);
      }
      setReleaseConfirmOpen(false);
      setReleaseError('');
      setHelpOpen(false);
    } catch (failure) {
      const msg = errorText(failure);
      setReleaseError(msg);
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  const mapPointerToDevice = (e: ReactPointerEvent<HTMLImageElement>, clamp: boolean): { x: number; y: number } | null => {
    const el = imgRef.current;
    if (!el || !el.complete || !el.naturalWidth || !el.naturalHeight) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / el.naturalWidth, rect.height / el.naturalHeight);
    const width = el.naturalWidth * scale;
    const height = el.naturalHeight * scale;
    const x = e.clientX - rect.left - (rect.width - width) / 2;
    const y = e.clientY - rect.top - (rect.height - height) / 2;
    if (!clamp && (x < 0 || x > width || y < 0 || y > height)) return null;
    const w = rpcState?.width || DEFAULT_WIDTH;
    const h = rpcState?.height || DEFAULT_HEIGHT;
    return {
      x: Math.min(w - 1, Math.max(0, Math.round(x / width * w))),
      y: Math.min(h - 1, Math.max(0, Math.round(y / height * h))),
    };
  };

  const onRpcPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    e.currentTarget.focus({ preventScroll: true });
    if (!rpcState?.live || !rpcState?.userControl || busy) return;
    const pt = mapPointerToDevice(e, false);
    if (!pt) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    gestureStartRef.current = { ...pt, at: Date.now(), pointerId: e.pointerId };
  };

  const onRpcPointerUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    const start = gestureStartRef.current;
    if (!start || start.pointerId !== e.pointerId) return;
    gestureStartRef.current = null;
    if (!canUseRpcFallback || !rpcCall || !baseParams) return;
    const sid = rpcState?.sessionId || lastSessionIdRef.current;
    if (!sid) return;
    const end = mapPointerToDevice(e, true);
    if (!end) return;
    const dist = Math.hypot(end.x - start.x, end.y - start.y);
    const durationMs = Math.min(MAX_SWIPE_DURATION_MS, Math.max(MIN_SWIPE_DURATION_MS, Date.now() - start.at));
    void (async () => {
      try {
        if (dist < SWIPE_THRESHOLD_PX) {
          await rpcCall('sendShowerInput', {
            ...baseParams,
            sessionId: sid,
            input: { type: 'click', x: end.x, y: end.y },
          });
        } else {
          await rpcCall('sendShowerInput', {
            ...baseParams,
            sessionId: sid,
            input: {
              type: 'drag',
              x1: start.x,
              y1: start.y,
              x2: end.x,
              y2: end.y,
              durationMs,
            },
          });
        }
        await refreshRpcStatus(true);
      } catch (failure) {
        setError(errorText(failure));
      }
    })();
  };

  const onRpcKeyDown = (e: ReactKeyboardEvent<HTMLImageElement>) => {
    if (e.nativeEvent.isComposing) return;
    // Shift+Escape exits focus from the screen canvas cleanly so keyboard users are never trapped.
    if (e.key === 'Escape' && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.blur();
      (backBtnRef.current ?? helpBtnRef.current)?.focus({ preventScroll: true });
      return;
    }

    if (!rpcState?.live) return;

    if (!rpcState.userControl) {
      if ((e.key === 'Enter' || e.key === ' ') && !busy) {
        e.preventDefault();
        void takeover();
      } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !busy) {
        e.preventDefault();
        void refreshRpcStatus(true);
      }
      return;
    }

    // Preserve Tab for normal focus order.
    if (e.key === 'Tab') return;
    if (busy || !canUseRpcFallback || !rpcCall || !baseParams) return;
    const sid = rpcState.sessionId || lastSessionIdRef.current;
    if (!sid) return;

    const mappedKey = RPC_KEY_MAP[e.key];
    if (mappedKey) {
      e.preventDefault();
      if (mappedKey === 'ESCAPE') e.stopPropagation();
      const modifiers: string[] = [];
      if (e.ctrlKey) modifiers.push('CTRL');
      if (e.altKey) modifiers.push('ALT');
      if (e.shiftKey) modifiers.push('SHIFT');
      if (e.metaKey) modifiers.push('META');
      void (async () => {
        try {
          await rpcCall('sendShowerInput', {
            ...baseParams,
            sessionId: sid,
            input: modifiers.length
              ? { type: 'key', key: mappedKey, modifiers }
              : { type: 'key', key: mappedKey },
          });
          await refreshRpcStatus(true);
        } catch (failure) {
          setError(errorText(failure));
        }
      })();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
      e.preventDefault();
      const text = e.key;
      void (async () => {
        try {
          await rpcCall('sendShowerInput', {
            ...baseParams,
            sessionId: sid,
            input: { type: 'text', text },
          });
          await refreshRpcStatus(true);
        } catch (failure) {
          setError(errorText(failure));
        }
      })();
    }
  };

  const activeState = isNativeClient ? state : rpcState;
  const supported = isNativeClient || canUseRpcFallback;
  const phase = supported ? activeState?.phase ?? 'connecting' : 'unsupported';
  const live = supported && phase === 'live' && activeState?.live === true;
  const userControl = live && activeState?.userControl === true;

  let statusText = '';
  if (!supported) {
    if (hostKind === 'remote' && !showerConnected) {
      statusText = t('远程设备离线或未连接', 'Remote device offline or disconnected');
    } else if (resolution.kind === 'unsupported' && resolution.reason === 'not-created') {
      statusText = t('这个 Bot 还没有屏幕，用到屏幕时会自动创建', 'This Bot has no screen yet. It is created automatically when needed');
    } else {
      statusText = t('当前环境暂无活跃屏幕', 'No active screen in this environment');
    }
  } else if (phase === 'none') {
    statusText = t('当前空闲，Bot 用到电脑屏幕时会自动开启', 'Idle. The screen starts automatically when the Bot needs it');
  } else if (phase === 'ended') {
    statusText = t('屏幕已关闭，Bot 下次用到时会自动重新开启', 'Screen closed. It will reopen automatically when needed');
  } else if (phase === 'authentication-required') {
    statusText = t('等待设备认证…', 'Waiting for device authentication…');
  } else if (phase === 'error' || phase === 'unavailable') {
    statusText = activeState?.message || t('画面连接失败，正在重试…', 'Connection failed, retrying…');
  } else if (!live) {
    statusText = t('正在连接电脑画面…', 'Connecting to screen…');
  }

  const metaText = !live
    ? hostKind === 'remote' && !showerConnected
      ? t('离线', 'Offline')
      : phase === 'authentication-required'
        ? t('等待认证', 'Authentication required')
        : phase === 'error' || phase === 'unavailable'
          ? t('连接失败', 'Connection failed')
          : phase === 'connecting'
            ? t('连接中', 'Connecting')
            : t('空闲', 'Idle')
    : userControl
      ? t('人工接管中 · 可直接触控屏幕', 'In control · Touch screen directly')
      : t(`实时 · ${activeState?.width ?? 0}×${activeState?.height ?? 0}`, `Live · ${activeState?.width ?? 0}×${activeState?.height ?? 0}`);

  return (
    <main ref={screenRef} className="grok-computer-screen grok-page-enter" aria-label={t('Bot 电脑屏幕', 'Bot Computer Screen')}>
      {/* Top Bar */}
      <header className="grok-computer-topbar">
        <button
          ref={backBtnRef}
          type="button"
          className="grok-computer-circle-btn"
          aria-label={t('返回', 'Back')}
          onClick={onBack}
        >
          <ChevronLeft size={22} aria-hidden="true" />
        </button>

        <div className="grok-computer-bot-id">
          <GrokBotAvatar preset={avatarPreset} isPrimary={isPrimary} size={32} />
          <div className="grok-computer-bot-details">
            <span className="grok-computer-bot-name">{botName}</span>
            <span className="grok-computer-host-label">{hostLabel}</span>
          </div>
        </div>

        <button
          ref={helpBtnRef}
          type="button"
          className={`grok-computer-circle-btn${helpOpen ? ' active' : ''}`}
          aria-label={t('屏幕信息与选项', 'Screen info & options')}
          aria-expanded={helpOpen}
          aria-haspopup="dialog"
          onClick={() => setHelpOpen(v => !v)}
        >
          <CircleHelp size={20} aria-hidden="true" />
        </button>
      </header>

      <Dialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        title={t('虚拟电脑状态', 'Virtual Screen Status')}
        description={t('查看当前虚拟屏幕状态并执行启动、刷新或关闭操作。', 'View virtual screen status and start, refresh, or close the screen.')}
        className="grok-computer-help-dialog"
        onCloseAutoFocus={event => {
          if (open && helpBtnRef.current) {
            event.preventDefault();
            helpBtnRef.current.focus();
          }
        }}
      >
        <div className="grok-computer-help-title" style={{ marginBottom: 'var(--space-2)' }}>
          <span
            className={`grok-computer-status-pill tabular-nums${live ? ' live' : ''}`}
            style={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', whiteSpace: 'normal' }}
          >
            {metaText}
          </span>
        </div>
        <p
          className="grok-computer-help-desc secondary"
          style={{ margin: '0 0 var(--space-3)', overflowWrap: 'anywhere', lineHeight: 1.5 }}
        >
          {t('Bot 在后台执行应用任务时会在此虚拟屏幕中运行。点击右下角「接管控制」可中断当前任务并由你直接触控操作。', 'The Bot operates apps inside this virtual screen. Tap "Take over" at the bottom-right to interrupt the Bot and interact directly.')}
        </p>
        {canControlSession && (
          <div className="grok-computer-help-actions">
            <button
              type="button"
              className="grok-computer-action-chip"
              disabled={busy}
              onClick={() => void handleCreateRpcScreen()}
            >
              <Play size={14} aria-hidden="true" />
              <span>{live ? t('重置屏幕', 'Reset') : t('启动屏幕', 'Start Screen')}</span>
            </button>
            <button
              type="button"
              className="grok-computer-action-chip"
              disabled={busy}
              onClick={() => {
                if (isNativeClient) pushLayout();
                else void refreshRpcStatus(true);
                setHelpOpen(false);
              }}
            >
              <RefreshCw size={14} aria-hidden="true" />
              <span>{t('刷新画面', 'Refresh')}</span>
            </button>
            {live && (
              <button
                type="button"
                className="grok-computer-action-chip danger"
                disabled={busy}
                onClick={() => {
                  setReleaseError('');
                  setHelpOpen(false);
                  setReleaseConfirmOpen(true);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{t('关闭屏幕', 'Close Screen')}</span>
              </button>
            )}
          </div>
        )}
      </Dialog>

      <ConfirmDialog
        open={releaseConfirmOpen}
        title={t('关闭虚拟屏幕？', 'Close virtual screen?')}
        description={t('关闭虚拟屏幕会立即结束当前会话并释放环境，未保存的应用状态会丢失；仅退出查看请点击左上角返回。', 'Closing the virtual screen immediately ends the current session and releases the environment. Unsaved app state will be lost. To only leave the view, tap Back.')}
        danger
        busy={busy}
        error={releaseError || null}
        confirmLabel={busy ? t('关闭中…', 'Closing…') : t('关闭屏幕', 'Close Screen')}
        cancelLabel={t('取消', 'Cancel')}
        onCancel={() => {
          if (!busy) {
            setReleaseConfirmOpen(false);
            setReleaseError('');
          }
        }}
        onConfirm={() => {
          void handleReleaseRpcScreen();
        }}
        onCloseAutoFocus={event => {
          const target = helpBtnRef.current?.isConnected ? helpBtnRef.current : backBtnRef.current;
          if (open && target?.isConnected) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      />

      {/* Full-Screen Center Stage (always-dark stage tokens) */}
      <div
        className="grok-computer-stage"
        ref={stageRef}
        style={{ background: 'var(--stage-dark-ground)' }}
      >
        {!isNativeClient && live && rpcFrameSrc ? (
          <img
            ref={imgRef}
            className={`grok-computer-frame-img${userControl ? ' interactive' : ''}`}
            src={rpcFrameSrc}
            alt={t('Bot 虚拟屏幕画面', 'Bot virtual screen')}
            tabIndex={0}
            role={userControl ? 'application' : undefined}
            aria-label={
              userControl
                ? t('Bot 虚拟屏幕实时画布，可直接触控或按方向键、回车、退格键发送按键，按 Shift+Esc 退出画布焦点', 'Interactive Bot virtual screen canvas. Touch directly or press Arrow keys, Enter, or Backspace to send input. Press Shift+Escape to leave focus.')
                : t('Bot 虚拟屏幕实时画面，按回车接管控制，按 R 刷新画面', 'Live Bot virtual screen. Press Enter to take over control, or R to refresh.')
            }
            draggable={false}
            onPointerDown={onRpcPointerDown}
            onPointerUp={onRpcPointerUp}
            onPointerCancel={e => {
              if (gestureStartRef.current?.pointerId === e.pointerId) gestureStartRef.current = null;
            }}
            onKeyDown={onRpcKeyDown}
          />
        ) : null}

        {!live && (
          <div
            className="grok-computer-empty-status"
            role="status"
            style={{ color: 'var(--stage-dark-ink-muted)' }}
          >
            <div className="grok-computer-empty-icon" aria-hidden="true">
              <Monitor size={30} />
            </div>
            <p style={{ overflowWrap: 'anywhere', maxWidth: '100%' }}>{statusText}</p>
            {canControlSession && (phase === 'none' || phase === 'ended') && (
              <button
                type="button"
                className="grok-computer-start-pill"
                disabled={busy}
                onClick={() => void handleCreateRpcScreen()}
              >
                <Play size={15} aria-hidden="true" />
                <span>{busy ? t('正在启动…', 'Starting…') : t('启动虚拟屏幕', 'Start Virtual Screen')}</span>
              </button>
            )}
            {supported && (phase === 'error' || phase === 'unavailable') && (
              <button
                type="button"
                className="grok-computer-start-pill"
                disabled={busy}
                onClick={() => {
                  setError('');
                  if (isNativeClient) {
                    const viewer = viewerRef.current;
                    if (viewer) {
                      void viewer.status().then(next => {
                        if (viewerRef.current === viewer) setState(next);
                      }).catch(failure => setError(errorText(failure)));
                    }
                    pushLayout();
                  } else {
                    void refreshRpcStatus(true);
                  }
                }}
              >
                <RefreshCw size={15} aria-hidden="true" />
                <span>{t('重试连接', 'Retry connection')}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="grok-computer-error">
          <ErrorNotice
            error={error}
            darkGlass
            compact
            onDismiss={() => setError('')}
          />
        </div>
      )}

      {/* Bottom Bar with Right-Aligned Takeover Pill */}
      <footer className="grok-computer-bottombar">
        <span
          className="grok-computer-bottom-meta tabular-nums"
          style={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', whiteSpace: 'normal' }}
        >
          {userControl ? (
            t('你可以直接触控屏幕，Bot 也可能同时操作', 'Direct touch active')
          ) : live ? (
            <span
              className="grok-computer-status-pill tabular-nums live"
              style={{ fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', whiteSpace: 'normal' }}
            >
              {metaText}
            </span>
          ) : (
            ''
          )}
        </span>
        <button
          type="button"
          className={`grok-computer-takeover-pill${userControl ? ' active' : ''}`}
          disabled={!live || userControl || busy}
          onClick={() => void takeover()}
        >
          <span>
            {userControl
              ? t('已接管控制', 'In Control')
              : busy
                ? t('正在接管…', 'Taking over…')
                : t('接管控制', 'Take over')}
          </span>
        </button>
      </footer>
    </main>
  );
}
