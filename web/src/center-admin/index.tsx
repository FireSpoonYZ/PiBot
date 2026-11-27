import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { useText } from '../ui';
import './center-admin.css';
import { clearCenterAdminCache, getCenterAdminScopeKey } from './cache';
import { CapabilitiesTab } from './CapabilitiesTab';
import { DevicesTab } from './DevicesTab';
import { GoogleTab, clearPendingGoogleFlow } from './GoogleTab';
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
  backHandlerRef,
}: CenterAdminPanelProps): React.JSX.Element {
  const t = useText();
  const [internalTab, setInternalTab] = useState<CenterAdminTab>(() =>
    normalizeCenterAdminTab(initialTab),
  );

  useEffect(() => {
    setInternalTab(normalizeCenterAdminTab(initialTab));
  }, [initialTab]);

  const currentTab: CenterAdminTab = normalizeCenterAdminTab(activeTab ?? internalTab);

  const navGuardRef = useRef<((nextTab: CenterAdminTab) => boolean) | null>(null);
  const subviewBackHandlerRef = useRef<(() => boolean) | null>(null);

  const registerNavGuard = useCallback(
    (guard: ((nextTab: CenterAdminTab) => boolean) | null) => {
      navGuardRef.current = guard;
    },
    [],
  );

  const registerBackHandler = useCallback(
    (handler: () => boolean) => {
      subviewBackHandlerRef.current = handler;
      return () => {
        if (subviewBackHandlerRef.current === handler) {
          subviewBackHandlerRef.current = null;
        }
      };
    },
    [],
  );

  useEffect(() => {
    if (!backHandlerRef) return;
    backHandlerRef.current = () => Boolean(subviewBackHandlerRef.current?.());
    return () => {
      backHandlerRef.current = null;
    };
  }, [backHandlerRef]);

  const commitTabChange = useCallback(
    (next: CenterAdminTab) => {
      if (activeTab === undefined) {
        setInternalTab(next);
      }
      onTabChange?.(next);
    },
    [activeTab, onTabChange],
  );

  const selectTab = useCallback(
    (next: CenterAdminTab) => {
      if (next === currentTab) return;
      if (navGuardRef.current && !navGuardRef.current(next)) {
        return;
      }
      commitTabChange(next);
    },
    [commitTabChange, currentTab],
  );

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
      clearPendingGoogleFlow(prev);
      prevScopeRef.current = scopeKey;
    }
  }, [scopeKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleUnauth = () => {
      clearCenterAdminCache(scopeKey);
      clearPendingGoogleFlow(scopeKey);
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
            onRegisterBackHandler={registerBackHandler}
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
            onRegisterBackHandler={registerBackHandler}
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
            onRegisterBackHandler={registerBackHandler}
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
        return (
          <WebhooksTab
            api={api}
            active
            cacheKey={scopeKey}
            onRegisterNavGuard={registerNavGuard}
            onNavigateTab={commitTabChange}
            onRegisterBackHandler={registerBackHandler}
          />
        );
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
