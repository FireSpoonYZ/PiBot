import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';

export interface CenterAdminRequestParams {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

type AdminBrokerFn = (
  identity: DesktopIdentity,
  op: 'center_admin_request',
  params: CenterAdminRequestParams,
) => Promise<unknown>;

const MAX_ADMIN_BROKER_CONCURRENCY = 2;
let activeAdminBrokerCalls = 0;
const adminBrokerQueue: Array<() => void> = [];

async function withAdminBrokerSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeAdminBrokerCalls >= MAX_ADMIN_BROKER_CONCURRENCY) {
    await new Promise<void>(resolve => {
      adminBrokerQueue.push(resolve);
    });
  }
  activeAdminBrokerCalls += 1;
  try {
    return await fn();
  } finally {
    activeAdminBrokerCalls -= 1;
    const next = adminBrokerQueue.shift();
    if (next) next();
  }
}

export async function centerAdminRequest<T = unknown>(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  params: CenterAdminRequestParams,
): Promise<T> {
  const broker = api.broker as unknown as AdminBrokerFn;
  return (await withAdminBrokerSlot(() => broker(identity, 'center_admin_request', params))) as T;
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function errorCodeOf(failure: unknown): string {
  if (typeof failure === 'object' && failure !== null && 'code' in failure) {
    const code = (failure as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

export function isCenterAuthOrBindError(failure: unknown): {
  oauthRevoked: boolean;
  notConnected: boolean;
  unauthorized: boolean;
} {
  const code = errorCodeOf(failure);
  const oauthRevoked = code === 'OAUTH_ACCESS_REVOKED' || code === 'OAUTH_REQUIRED';
  const notConnected = code === 'NOT_CONNECTED';
  const unauthorized = code === 'CONTROL_UNAUTHORIZED' || code === 'UNAUTHORIZED';
  return { oauthRevoked, notConnected, unauthorized };
}

export interface PolledOperation {
  id: string;
  phase?: string;
  installationId?: string;
  error?: string | { message?: string };
}

function defaultBrokerText(zh: string, en: string): string {
  const lang = typeof document !== 'undefined' && document.documentElement.lang
    ? document.documentElement.lang
    : (typeof navigator !== 'undefined' ? navigator.language : 'zh');
  return lang.toLowerCase().startsWith('zh') ? zh : en;
}

export async function pollCenterOperation(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  operationId: string,
  options?: { maxAttempts?: number; intervalMs?: number; t?: (zh: string, en: string) => string },
): Promise<PolledOperation> {
  const maxAttempts = options?.maxAttempts ?? 40;
  const intervalMs = options?.intervalMs ?? 300;
  const t = options?.t ?? defaultBrokerText;
  for (let i = 0; i < maxAttempts; i += 1) {
    const op = await centerAdminRequest<PolledOperation>(api, identity, {
      method: 'GET',
      path: `/api/operations/${encodeURIComponent(operationId)}`,
    });
    if (op.phase === 'applied') return op;
    if (op.phase === 'failed') {
      const msg = typeof op.error === 'string'
        ? op.error
        : (op.error?.message ?? t('操作执行失败', 'Operation failed'));
      throw new Error(msg);
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(t('操作等待超时，请稍后刷新查看', 'Operation timed out. Please refresh to check status.'));
}
