import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ModelSettingsPage } from '../bot-settings/ModelSettingsPage';
import { SettingsSheet } from '../bot-settings/primitives';
import { useBotModelConfig } from '../bot-settings/useBotModelConfig';
import { ErrorNotice, useText } from '../ui';

export interface MobileModelSettingsHostProps {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  botId: string;
  deviceId?: string;
  onClose(): void;
  onOpenCenterAdmin?(): void;
}

export function MobileModelSettingsHost({
  api,
  identity,
  botId,
  deviceId,
  onClose,
  onOpenCenterAdmin,
}: MobileModelSettingsHostProps) {
  const t = useText();
  const targetDeviceId = deviceId ?? identity.targetDeviceId;
  const state = useBotModelConfig(api, identity, targetDeviceId, botId);

  const initialLoadFailed = !state.loading && !state.config && !state.oauthRevoked && !state.notConnected;
  if (initialLoadFailed) {
    return (
      <SettingsSheet title={t('模型设置', 'Model')} onClose={onClose}>
        <ErrorNotice
          error={
            state.error ||
            t('未能读取该 Bot 的模型配置，请检查中心连接后重试。', 'Could not load model settings for this Bot. Check your center connection and try again.')
          }
          actionLabel={t('重新加载', 'Reload settings')}
          onAction={() => void state.reload()}
          secondaryActionLabel={onOpenCenterAdmin ? t('中心管理', 'Center Admin') : undefined}
          onSecondaryAction={onOpenCenterAdmin}
        />
      </SettingsSheet>
    );
  }

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
