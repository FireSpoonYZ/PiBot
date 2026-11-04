// 按 Bot 所在 Host 选择屏幕客户端。远端 Host（Windows/Linux/另一台 Android）走 RemoteScreenMethods，
// 本期未实现，返回 unsupported 原因供界面展示。
import { androidShowerClient } from './androidShower';
import type { ScreenClient } from './types';

export * from './types';

export type ScreenTarget = { botId: string; hostKind: 'local' | 'remote' };
export type ScreenResolution =
  | { kind: 'client'; client: ScreenClient }
  | { kind: 'unsupported'; reason: 'remote' | 'environment' | 'not-created' };

const inTauriUi = () => (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;

export function resolveScreenClient(target: ScreenTarget): ScreenResolution {
  if (target.hostKind === 'remote') return { kind: 'unsupported', reason: 'remote' };
  // 本机 Host 只在 Tauri Android 界面（:tauri_ui）提供原生覆盖层；旧 Capacitor 入口不提供。
  if (!inTauriUi()) return { kind: 'unsupported', reason: 'environment' };
  // 尚未落地的默认 Bot 还没有 Host 身份，也就没有屏幕。
  if (!target.botId || target.botId.startsWith('__')) return { kind: 'unsupported', reason: 'not-created' };
  return { kind: 'client', client: androidShowerClient };
}
