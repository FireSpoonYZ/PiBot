// 手机端 Bot 设置抽屉入口：按 tab 展示模型设置、工具与插件、或技能闭环管理。
import { useState } from 'react';
import type { DesktopIdentity, DesktopPanelApi } from '../../desktop/web/src/types';
import { useText } from './ui';
import { AdvancedSettingsPage } from './bot-settings/AdvancedSettingsPage';
import { BotSkillsPage } from './bot-settings/BotSkillsPage';
import { CapabilitiesPage } from './bot-settings/CapabilitiesPage';
import { ModelSettingsPage } from './bot-settings/ModelSettingsPage';
import { SettingsSheet } from './bot-settings/primitives';
import { useBotModelConfig } from './bot-settings/useBotModelConfig';

export type BotSettingsTab = 'model' | 'capabilities' | 'skills' | 'advanced';

interface Props {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  botName?: string;
  initialTab?: BotSettingsTab;
  onClose(): void;
  onOpenCenterAdmin?: () => void;
}

type Target = { identity: DesktopIdentity; deviceId: string; botId: string };

export function BotModelSheet({
  api,
  identity,
  botId,
  botName,
  initialTab = 'model',
  onClose,
  onOpenCenterAdmin,
}: Props) {
  const t = useText();
  const [target] = useState<Target>(() => ({ identity, deviceId: identity.targetDeviceId, botId }));

  if (initialTab === 'capabilities') {
    return (
      <CapabilitiesPage
        api={api}
        identity={target.identity}
        deviceId={target.deviceId}
        botId={target.botId}
        mode="tools"
        onClose={onClose}
        onOpenCenterAdmin={onOpenCenterAdmin}
      />
    );
  }

  if (initialTab === 'skills') {
    return (
      <SettingsSheet title={t('技能管理', 'Skills')} onClose={onClose}>
        <BotSkillsPage
          api={api}
          identity={target.identity}
          deviceId={target.deviceId}
          botId={target.botId}
          botName={botName}
        />
      </SettingsSheet>
    );
  }

  return (
    <ModelConfigHost
      api={api}
      target={target}
      tab={initialTab}
      onClose={onClose}
      onOpenCenterAdmin={onOpenCenterAdmin}
    />
  );
}

function ModelConfigHost({
  api,
  target,
  tab,
  onClose,
  onOpenCenterAdmin,
}: {
  api: DesktopPanelApi;
  target: Target;
  tab: 'model' | 'advanced';
  onClose(): void;
  onOpenCenterAdmin?: () => void;
}) {
  const state = useBotModelConfig(api, target.identity, target.deviceId, target.botId);
  return tab === 'advanced'
    ? <AdvancedSettingsPage state={state} api={api} identity={target.identity} onClose={onClose} onOpenCenterAdmin={onOpenCenterAdmin} />
    : <ModelSettingsPage state={state} api={api} identity={target.identity} onClose={onClose} onOpenCenterAdmin={onOpenCenterAdmin} />;
}
