import { useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { useText } from '../ui';
import './center-admin.css';
import { clearCenterAdminCache, getCenterAdminScopeKey } from './cache';
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
  const scopeKey = useMemo(() => getCenterAdminScopeKey(transport, centerUrl), [transport, centerUrl]);

  const prevScopeRef = useRef(scopeKey);
  const [visitedByScope, setVisitedByScope] = useState<{
    scopeKey: string;
    tabs: CenterAdminTab[];
  }>(() => ({ scopeKey, tabs: [currentTab] }));

  useEffect(() => {
    const prev = prevScopeRef.current;
    if (prev !== scopeKey) {
      clearCenterAdminCache(prev);
      prevScopeRef.current = scopeKey;
    }
  }, [scopeKey]);

  useEffect(() => {
    setVisitedByScope(prev => {
      if (prev.scopeKey !== scopeKey) {
        return { scopeKey, tabs: [currentTab] };
      }
      if (prev.tabs.includes(currentTab)) return prev;
      return { scopeKey, tabs: [...prev.tabs, currentTab] };
    });
  }, [currentTab, scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleUnauth = () => {
      clearCenterAdminCache(scopeKey);
    };
    window.addEventListener('center-unauthenticated', handleUnauth);
    return () => window.removeEventListener('center-unauthenticated', handleUnauth);
  }, [scopeKey]);

  const mountedTabs = useMemo(() => {
    const set = new Set<CenterAdminTab>(
      visitedByScope.scopeKey === scopeKey ? visitedByScope.tabs : [],
    );
    set.add(currentTab);
    return set;
  }, [currentTab, scopeKey, visitedByScope]);

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
          {mountedTabs.has('providers') && (
            <div
              className={`ca-tab-pane${currentTab === 'providers' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'providers' || undefined}
            >
              <ProvidersTab
                api={api}
                active={currentTab === 'providers'}
                cacheKey={scopeKey}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            </div>
          )}
          {mountedTabs.has('capabilities') && (
            <div
              className={`ca-tab-pane${currentTab === 'capabilities' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'capabilities' || undefined}
            >
              <CapabilitiesTab
                api={api}
                active={currentTab === 'capabilities'}
                cacheKey={scopeKey}
                onOpenExternal={onOpenExternal}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            </div>
          )}
          {mountedTabs.has('google') && (
            <div
              className={`ca-tab-pane${currentTab === 'google' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'google' || undefined}
            >
              <GoogleTab
                api={api}
                active={currentTab === 'google'}
                cacheKey={scopeKey}
                centerUrl={centerUrl}
                onOpenExternalUrl={onOpenExternalUrl}
                onConfigureBot={onConfigureBot}
                onStartGoogleSetupWizard={onStartGoogleSetupWizard}
              />
            </div>
          )}
          {mountedTabs.has('devices') && (
            <div
              className={`ca-tab-pane${currentTab === 'devices' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'devices' || undefined}
            >
              <DevicesTab
                api={api}
                active={currentTab === 'devices'}
                cacheKey={scopeKey}
                onConfigureBot={onConfigureBot}
                renderQr={renderQr}
              />
            </div>
          )}
          {mountedTabs.has('vault') && (
            <div
              className={`ca-tab-pane${currentTab === 'vault' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'vault' || undefined}
            >
              <VaultTab api={api} active={currentTab === 'vault'} cacheKey={scopeKey} />
            </div>
          )}
          {mountedTabs.has('ops') && (
            <div
              className={`ca-tab-pane${currentTab === 'ops' ? '' : ' is-hidden'}`}
              aria-hidden={currentTab !== 'ops' || undefined}
            >
              <OpsTab
                api={api}
                active={currentTab === 'ops'}
                cacheKey={scopeKey}
                onOpenExternal={onOpenExternal}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
