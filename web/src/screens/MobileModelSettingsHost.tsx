import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ModelSettingsPage } from '../bot-settings/ModelSettingsPage';
import { useBotModelConfig } from '../bot-settings/useBotModelConfig';

export interface MobileModelSettingsHostProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  onClose(): void;
  onOpenCenterAdmin?(): void;
}

export function MobileModelSettingsHost({
  api,
  identity,
  botId,
  onClose,
  onOpenCenterAdmin,
}: MobileModelSettingsHostProps) {
  const state = useBotModelConfig(api, identity, identity.targetDeviceId, botId);
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
