import { useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { useText } from '../ui';
import './center-admin.css';
import { clearCenterAdminCache, getCenterAdminScopeKey } from './cache';
import { CapabilitiesTab } from './CapabilitiesTab';
import { DevicesTab } from './DevicesTab';
import { GoogleTab } from './GoogleTab';
import { ProvidersTab } from './ProvidersTab';
import { ReleasesTab } from './ReleasesTab';
import { VaultTab } from './VaultTab';
import { WebhooksTab } from './WebhooksTab';
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
  clearCenterAdminCache,
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

const VALID_TABS: ReadonlySet<string> = new Set<CenterAdminTab>([
  'providers',
  'devices',
  'capabilities',
  'google',
  'vault',
  'webhooks',
  'releases',
]);

function normalizeCenterAdminTab(tab: CenterAdminTab | string | undefined): CenterAdminTab {
  if (tab && VALID_TABS.has(tab)) {
    return tab as CenterAdminTab;
  }
  return 'providers';
}

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
  const [internalTab, setInternalTab] = useState<CenterAdminTab>(() =>
    normalizeCenterAdminTab(initialTab),
  );

  useEffect(() => {
    setInternalTab(normalizeCenterAdminTab(initialTab));
  }, [initialTab]);

  const currentTab: CenterAdminTab = normalizeCenterAdminTab(activeTab ?? internalTab);

  const selectTab = (next: CenterAdminTab) => {
    if (activeTab === undefined) {
      setInternalTab(next);
    }
    onTabChange?.(next);
  };

  const tabs: readonly { id: CenterAdminTab; label: string }[] = useMemo(
    () => [
      { id: 'providers', label: t('模型', 'Models') },
      { id: 'devices', label: t('设备', 'Devices') },
      { id: 'capabilities', label: t('能力', 'Capabilities') },
      { id: 'google', label: 'Google' },
      { id: 'vault', label: t('密码库', 'Vault') },
      { id: 'webhooks', label: 'Webhook' },
      { id: 'releases', label: t('客户端发布', 'Releases') },
    ],
    [t],
  );

  const api = useMemo(() => createCenterApi(transport), [transport]);
  const scopeKey = useMemo(() => getCenterAdminScopeKey(transport, centerUrl), [transport, centerUrl]);

  const prevScopeRef = useRef(scopeKey);

  useEffect(() => {
    const prev = prevScopeRef.current;
    if (prev !== scopeKey) {
      clearCenterAdminCache(prev);
      prevScopeRef.current = scopeKey;
    }
  }, [scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleUnauth = () => {
      clearCenterAdminCache(scopeKey);
    };
    window.addEventListener('center-unauthenticated', handleUnauth);
    return () => window.removeEventListener('center-unauthenticated', handleUnauth);
  }, [scopeKey]);

  const renderActiveTab = (): React.JSX.Element => {
    switch (currentTab) {
      case 'providers':
        return (
          <ProvidersTab
            api={api}
            active
            cacheKey={scopeKey}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      case 'devices':
        return (
          <DevicesTab
            api={api}
            active
            cacheKey={scopeKey}
            onConfigureBot={onConfigureBot}
            renderQr={renderQr}
          />
        );
      case 'capabilities':
        return (
          <CapabilitiesTab
            api={api}
            active
            cacheKey={scopeKey}
            onOpenExternal={onOpenExternal}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      case 'google':
        return (
          <GoogleTab
            api={api}
            active
            cacheKey={scopeKey}
            centerUrl={centerUrl}
            onOpenExternalUrl={onOpenExternalUrl}
            onConfigureBot={onConfigureBot}
            onStartGoogleSetupWizard={onStartGoogleSetupWizard}
          />
        );
      case 'vault':
        return <VaultTab api={api} active cacheKey={scopeKey} />;
      case 'webhooks':
        return <WebhooksTab api={api} active cacheKey={scopeKey} />;
      case 'releases':
        return (
          <ReleasesTab
            api={api}
            active
            cacheKey={scopeKey}
            onOpenExternal={onOpenExternal}
          />
        );
    }
  };

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

        <main key={scopeKey}>
          <div key={currentTab} className="ca-tab-pane">
            {renderActiveTab()}
          </div>
        </main>
      </div>
    </div>
  );
}
