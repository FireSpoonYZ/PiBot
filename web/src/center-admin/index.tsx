import { useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { ExternalLink } from 'lucide-react';
import './center-admin.css';
import { CapabilitiesTab } from './CapabilitiesTab';
import { DevicesTab } from './DevicesTab';
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
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
  SessionInfo,
  SetupRequest,
  SetupStatus,
};

const TABS: readonly { id: CenterAdminTab; label: string }[] = [
  { id: 'providers', label: '模型' },
  { id: 'capabilities', label: '技能与扩展' },
  { id: 'devices', label: '设备' },
  { id: 'vault', label: '密码库' },
  { id: 'ops', label: '触发与版本' },
];

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
  renderQr,
}: CenterAdminPanelProps): React.JSX.Element {
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

  const api = useMemo(() => createCenterApi(transport), [transport]);

  return (
    <div className={`ca-root${embedded ? ' is-embedded' : ''}`}>
      <div className="ca-shell">
        <div className="ca-topbar">
          <nav className="ca-nav" aria-label="中心管理导航">
            {TABS.map(tab => (
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
              title={centerUrl ? `在浏览器打开 ${centerUrl}` : '在浏览器打开'}
              onClick={onOpenExternal}
            >
              <ExternalLink size={14} />
              <span>在浏览器打开</span>
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
