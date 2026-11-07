// Bot 设置入口：按入口行打开单一用途的页面（模型 / 插件·技能·MCP / 高级设置），不再使用顶部分段标签。
import { useState } from 'react';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import { AdvancedSettingsPage } from './bot-settings/AdvancedSettingsPage';
import { CapabilitiesPage } from './bot-settings/CapabilitiesPage';
import { ModelSettingsPage } from './bot-settings/ModelSettingsPage';
import { useBotModelConfig } from './bot-settings/useBotModelConfig';

export type BotSettingsTab = 'model' | 'capabilities' | 'advanced';

type Props = { api: DesktopPanelApi; identity: DesktopIdentity; botId: string; initialTab?: BotSettingsTab; onClose(): void };

type Target = { identity: DesktopIdentity; deviceId: string; botId: string };

export function BotModelSheet({ api, identity, botId, initialTab = 'model', onClose }: Props) {
  // 打开时固定目标；身份代次或目标变化由宿主通过 key 重新挂载。
  const [target] = useState<Target>(() => ({ identity, deviceId: identity.targetDeviceId, botId }));
  if (initialTab === 'capabilities') {
    return <CapabilitiesPage api={api} identity={target.identity} deviceId={target.deviceId} botId={target.botId} onClose={onClose} />;
  }
  return <ModelConfigHost api={api} target={target} tab={initialTab} onClose={onClose} />;
}

function ModelConfigHost({ api, target, tab, onClose }: { api: DesktopPanelApi; target: Target; tab: 'model' | 'advanced'; onClose(): void }) {
  const state = useBotModelConfig(api, target.identity, target.deviceId, target.botId);
  return tab === 'advanced'
    ? <AdvancedSettingsPage state={state} onClose={onClose} />
    : <ModelSettingsPage state={state} api={api} identity={target.identity} onClose={onClose} />;
}
