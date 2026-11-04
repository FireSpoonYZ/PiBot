// 本机（Android Capacitor / Tauri）薄适配：直接复用 desktop/web 的 ShowerPreview 与同一套 6 个
// 控制方法，只在 call 上换桥（本机 BotHost.call 或 Host 注入的 remote 面板 call）。
// 协议/画布/CSS 全在共享组件里，这里不复制。
import { ShowerPreview as SharedShowerPreview } from '../../desktop/web/src/ShowerPreview';
import type { ShowerTarget } from '../../host-core/index.js';
import { BotHost } from './native';

/** 平台无关的 6 方法 RPC：method 是 Shower 控制方法，params 是扁平 {botId,scopeId?,...}。 */
export type ShowerCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** 既有本机 call 桥：Capacitor 插件与 Tauri 适配器都返回 {result}。 */
const callLocalHost: ShowerCall = async (method, params) =>
  (await BotHost.call({ method, params })).result;

export interface LocalShowerPreviewProps {
  target: ShowerTarget;
  connected: boolean;
  onClose(): void;
  /** 省略时走本机 BotHost.call；远程 Bot 由 Host 注入既有 remote 面板的 call。 */
  call?: ShowerCall;
}

export function ShowerPreview({ target, connected, onClose, call }: LocalShowerPreviewProps) {
  return (
    <SharedShowerPreview
      call={call ?? callLocalHost}
      target={target}
      connected={connected}
      onClose={onClose}
    />
  );
}
