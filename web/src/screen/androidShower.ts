// Android 本机 Host 的 Shower 实现：Tauri Android 界面里由原生 TextureView 覆盖层贴到占位元素上，
// 画面由 Shower 直接写入（零拷贝），接管后的触摸由原生层映射并转发，不经过 JS。
// 原生覆盖层是单例；每次 open 得到一个 session，过期会话的 layout/close 由原生侧忽略。
import { mobileLocalRequest } from '../native/tauri-host';
import {
  SCREEN_CAPABILITIES, type ScreenClient, type ScreenPhase, type ScreenViewState, type ScreenViewer, type ScreenViewport,
} from './types';

const PHASES: ReadonlySet<string> = new Set<ScreenPhase>(['idle', 'connecting', 'none', 'live', 'ended', 'error', 'unavailable']);
const IDLE: ScreenViewState = { phase: 'idle', live: false, userControl: false, width: 1, height: 1, platform: 'android-shower' };

type NativeScreenState = Partial<Omit<ScreenViewState, 'phase'>> & { phase?: string; session?: number };

function normalize(value: unknown): ScreenViewState {
  if (!value || typeof value !== 'object') return IDLE;
  const raw = value as NativeScreenState;
  return {
    phase: typeof raw.phase === 'string' && PHASES.has(raw.phase) ? raw.phase as ScreenPhase : 'idle',
    live: raw.live === true,
    userControl: raw.userControl === true,
    width: typeof raw.width === 'number' && raw.width > 0 ? raw.width : 1,
    height: typeof raw.height === 'number' && raw.height > 0 ? raw.height : 1,
    platform: 'android-shower',
    message: typeof raw.message === 'string' ? raw.message : undefined,
  };
}

class AndroidShowerViewer implements ScreenViewer {
  private closed = false;

  constructor(private readonly session: number) {}

  async layout(viewport: ScreenViewport): Promise<ScreenViewState> {
    if (this.closed) return IDLE;
    const dpr = window.devicePixelRatio || 1;
    const params = viewport
      ? { ...viewport, dpr, visible: true, session: this.session }
      : { x: 0, y: 0, width: 0, height: 0, radius: 0, dpr, visible: false, session: this.session };
    return normalize(await mobileLocalRequest('screenLayout', params));
  }

  async status(): Promise<ScreenViewState> {
    if (this.closed) return IDLE;
    return normalize(await mobileLocalRequest('screenStatus', { session: this.session }));
  }

  async takeover(): Promise<ScreenViewState> {
    if (this.closed) return IDLE;
    return normalize(await mobileLocalRequest('screenTakeover', { session: this.session }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await mobileLocalRequest('screenClose', { session: this.session });
  }
}

export const androidShowerClient: ScreenClient = {
  platform: 'android-shower',
  capabilities: SCREEN_CAPABILITIES['android-shower'],
  async open(botId: string) {
    const opened = await mobileLocalRequest<NativeScreenState>('screenOpen', { botId });
    if (typeof opened?.session !== 'number') throw new Error('Bot 屏幕会话无效');
    return new AndroidShowerViewer(opened.session);
  },
};
