import type { CenterAdminTab, CenterTransport } from './types';

const transportIds = new WeakMap<CenterTransport, number>();
let nextTransportId = 1;

export function getCenterAdminScopeKey(transport: CenterTransport, centerUrl?: string): string {
  const trimmed = centerUrl?.trim();
  if (trimmed) {
    return `url:${trimmed.replace(/\/+$/, '')}`;
  }
  let id = transportIds.get(transport);
  if (id === undefined) {
    id = nextTransportId++;
    transportIds.set(transport, id);
  }
  return `transport:${id}`;
}

export interface TabCacheEntry<T> {
  data: T;
  updatedAt: number;
}

const tabCaches = new Map<string, Map<CenterAdminTab, TabCacheEntry<unknown>>>();

export function readTabCache<T>(scopeKey: string, tab: CenterAdminTab): TabCacheEntry<T> | null {
  const byTab = tabCaches.get(scopeKey);
  if (!byTab) return null;
  const entry = byTab.get(tab);
  return entry ? (entry as TabCacheEntry<T>) : null;
}

export function writeTabCache<T>(scopeKey: string, tab: CenterAdminTab, data: T): void {
  let byTab = tabCaches.get(scopeKey);
  if (!byTab) {
    byTab = new Map();
    tabCaches.set(scopeKey, byTab);
  }
  byTab.set(tab, { data, updatedAt: Date.now() });
}

export function clearCenterAdminCache(scopeKey?: string): void {
  if (scopeKey === undefined) {
    tabCaches.clear();
    return;
  }
  tabCaches.delete(scopeKey);
}
