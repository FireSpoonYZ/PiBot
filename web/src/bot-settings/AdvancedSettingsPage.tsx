// 兼容转发页：高级工具调用方式已合并至单页 ModelSettingsPage 底部折叠区。
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ModelSettingsPage } from './ModelSettingsPage';
import type { BotModelConfigState } from './useBotModelConfig';

export interface AdvancedSettingsPageProps {
  state: BotModelConfigState;
  api?: DesktopPanelApi;
  identity?: DesktopIdentity;
  onClose?: () => void;
  onOpenCenterAdmin?: () => void;
}

export function AdvancedSettingsPage({
  state,
  api,
  identity,
  onClose,
  onOpenCenterAdmin,
}: AdvancedSettingsPageProps) {
  return (
    <ModelSettingsPage
      state={state}
      api={api}
      identity={identity}
      onClose={onClose}
      onOpenCenterAdmin={onOpenCenterAdmin}
    />
  );
}
