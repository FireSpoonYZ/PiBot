import { useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { useText } from '../ui';
import './center-admin.css';
import { CapabilitiesTab } from './CapabilitiesTab';
import { DevicesTab } from './DevicesTab';
import { GoogleTab } from './GoogleTab';
import { OpsTab } from './OpsTab';
import { ProvidersTab } from './ProvidersTab';
import { VaultTab } from './VaultTab';
import {
  CenterApiError,
  createBrokerCenterTransport,
  createCenterApi,
  createFetchCenterTransport,
  errorMessage,
} from './transport';
import type { FetchCenterTransport, FetchCenterTransportOptions } from './transport';
import type {
  CenterAdminPanelProps,
  CenterAdminTab,
  CenterTransport,
  GoogleAccountStatus,
  GoogleAuthorizeRequest,
  GoogleAuthorizeResponse,
  GoogleCancelRequest,
  GoogleCheckRequest,
  GoogleCheckResponse,
  GoogleClientStatus,
  GoogleConfigureRequest,
  GoogleFlowRequest,
  GoogleFlowResponse,
  GoogleRemoveRequest,
  GoogleRemoveResponse,
  GoogleRule,
  GoogleRuleRemoveRequest,
  GoogleRulesListResponse,
  GoogleServiceChoice,
  GoogleServiceId,
  GoogleServiceReadiness,
  GoogleServiceState,
  GoogleStatusResponse,
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
  SessionInfo,
  SetupRequest,
  SetupStatus,
} from './types';
import { QrSvg } from './qrSvg';

export {
  CenterApiError,
  QrSvg,
  createBrokerCenterTransport,
  createCenterApi,
  createFetchCenterTransport,
  errorMessage,
};

export { openExternalUrl } from './openExternalUrl';

export type {
  CenterAdminPanelProps,
  CenterAdminTab,
  CenterTransport,
  FetchCenterTransport,
  FetchCenterTransportOptions,
  GoogleAccountStatus,
  GoogleAuthorizeRequest,
  GoogleAuthorizeResponse,
  GoogleCancelRequest,
  GoogleCheckRequest,
  GoogleCheckResponse,
  GoogleClientStatus,
  GoogleConfigureRequest,
  GoogleFlowRequest,
  GoogleFlowResponse,
  GoogleRemoveRequest,
  GoogleRemoveResponse,
  GoogleRule,
  GoogleRuleRemoveRequest,
  GoogleRulesListResponse,
  GoogleServiceChoice,
  GoogleServiceId,
  GoogleServiceReadiness,
  GoogleServiceState,
  GoogleStatusResponse,
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
  SessionInfo,
  SetupRequest,
  SetupStatus,
};

export function CenterAdminPanel({
  transport,
  embedded = false,
  initialTab = 'providers',
  activeTab,
  onTabChange,
  centerUrl,
  onOpenExternal,
  onOpenExternalUrl,
  hideTopbarExternal = false,
  onConfigureBot,
  onStartGoogleSetupWizard,
  renderQr,
}: CenterAdminPanelProps): React.JSX.Element {
  const t = useText();
  const [internalTab, setInternalTab] = useState<CenterAdminTab>(initialTab);

  useEffect(() => {
    setInternalTab(initialTab);
  }, [initialTab]);

  const currentTab: CenterAdminTab = activeTab ?? internalTab;

  const selectTab = (next: CenterAdminTab) => {
    if (activeTab === undefined) {
      setInternalTab(next);
    }
    onTabChange?.(next);
  };

  const tabs: readonly { id: CenterAdminTab; label: string }[] = useMemo(
    () => [
      { id: 'providers', label: t('模型', 'Models') },
      { id: 'capabilities', label: t('技能与扩展', 'Skills & Extensions') },
      { id: 'google', label: 'Google' },
      { id: 'devices', label: t('设备', 'Devices') },
      { id: 'vault', label: t('密码库', 'Vault') },
      { id: 'ops', label: t('触发与版本', 'Triggers & Releases') },
    ],
    [t],
  );

  const api = useMemo(() => createCenterApi(transport), [transport]);

  return (
    <div className={`ca-root${embedded ? ' is-embedded' : ''}`}>
      <div className="ca-shell">
        <div className="ca-topbar">
          <nav className="ca-nav" aria-label={t('中心管理导航', 'Center admin navigation')}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                type="button"
                aria-current={currentTab === tab.id ? 'page' : undefined}
                className={`ca-nav-btn ${currentTab === tab.id ? 'is-active' : ''}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {onOpenExternal && !hideTopbarExternal && (
            <button
              type="button"
              className="ca-btn ca-btn-ghost ca-btn-sm"
              title={centerUrl ? t(`在浏览器打开 ${centerUrl}`, `Open ${centerUrl} in browser`) : t('在浏览器打开', 'Open in browser')}
              onClick={onOpenExternal}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>{t('在浏览器打开', 'Open in browser')}</span>
            </button>
          )}
        </div>

        <main>
          {currentTab === 'providers' && (
            <ProvidersTab api={api} onOpenExternalUrl={onOpenExternalUrl} />
          )}
          {currentTab === 'capabilities' && (
            <CapabilitiesTab
              api={api}
              onOpenExternal={onOpenExternal}
              onOpenExternalUrl={onOpenExternalUrl}
            />
          )}
          {currentTab === 'google' && (
            <GoogleTab
              api={api}
              centerUrl={centerUrl}
              onOpenExternalUrl={onOpenExternalUrl}
              onConfigureBot={onConfigureBot}
              onStartGoogleSetupWizard={onStartGoogleSetupWizard}
            />
          )}
          {currentTab === 'devices' && (
            <DevicesTab api={api} onConfigureBot={onConfigureBot} renderQr={renderQr} />
          )}
          {currentTab === 'vault' && <VaultTab api={api} />}
          {currentTab === 'ops' && <OpsTab api={api} onOpenExternal={onOpenExternal} />}
        </main>
      </div>
    </div>
  );
}
