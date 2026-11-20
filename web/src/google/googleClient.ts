// Real owner-broker API client for Center Google Workspace & target-Host browser/setup volatile RPCs.
// Never sends secrets or OAuth codes through chat messages, drafts, or durable outboxes.
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { centerAdminRequest, errorCodeOf, isCenterAuthOrBindError } from '../bot-settings/centerAdminBroker';
import type {
  BotBrowserControlCall,
  GoogleAccountView,
  GoogleAuthFlowStart,
  GoogleAuthFlowStatus,
  GoogleRuleDto,
  GoogleServiceChoice,
  GoogleStatusSnapshot,
  GoogleSetupControlCall,
  GoogleSetupControlState,
} from './types';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Unwrap Center standard `{ ok, data }` / `{ data }` envelope or return direct DTO. */
function unwrapEnvelope<T>(raw: unknown): T {
  const rec = asRecord(raw);
  if (!rec) return raw as T;
  if ('ok' in rec && rec.ok === false) {
    const errRec = asRecord(rec.error);
    const msg =
      (typeof errRec?.message === 'string' && errRec.message) ||
      (typeof rec.message === 'string' && rec.message) ||
      (typeof rec.error === 'string' && rec.error) ||
      'Request failed';
    const err = new Error(msg) as Error & { code?: string; status?: number };
    if (typeof errRec?.code === 'string') err.code = errRec.code;
    else if (typeof rec.code === 'string') err.code = rec.code;
    throw err;
  }
  if ('data' in rec && rec.data !== undefined) {
    return rec.data as T;
  }
  return raw as T;
}

export interface GoogleErrorClassification {
  code: string;
  message: string;
  adminRequired: boolean;
  authOrBind: boolean;
  tempError: boolean;
  offline: boolean;
  unavailable: boolean;
}

export function classifyGoogleError(failure: unknown): GoogleErrorClassification {
  const code = errorCodeOf(failure).toUpperCase();
  const status =
    failure && typeof failure === 'object' && 'status' in failure && typeof (failure as { status?: unknown }).status === 'number'
      ? (failure as { status: number }).status
      : undefined;
  const message =
    failure instanceof Error
      ? failure.message
      : failure && typeof failure === 'object' && 'message' in failure && typeof (failure as { message?: unknown }).message === 'string'
        ? (failure as { message: string }).message
        : String(failure ?? 'Unknown error');
  const lowerMsg = message.toLowerCase();
  const brokerAuth = isCenterAuthOrBindError(failure);

  const adminRequired =
    code === 'FORBIDDEN' ||
    code === 'ADMIN_REQUIRED' ||
    code === 'OWNER_REQUIRED' ||
    code === 'CENTER_ADMIN_REQUIRED' ||
    status === 403 ||
    lowerMsg.includes('admin required') ||
    lowerMsg.includes('owner required');

  const offline =
    code === 'OFFLINE' ||
    code === 'NOT_CONNECTED' ||
    code === 'CENTER_OFFLINE' ||
    code === 'HOST_OFFLINE' ||
    code === 'TARGET_OFFLINE';

  const unavailable =
    code === 'UNAVAILABLE' ||
    code === 'NOT_FOUND' ||
    code === 'METHOD_NOT_FOUND' ||
    code === 'CONTROL_UNAVAILABLE' ||
    code === 'GOOGLE_UNAVAILABLE' ||
    status === 404 ||
    status === 501 ||
    lowerMsg.includes('not implemented') ||
    lowerMsg.includes('unknown method');

  const tempError =
    !adminRequired &&
    !brokerAuth.oauthRevoked &&
    (code === 'TIMEOUT' ||
      code === 'NETWORK_ERROR' ||
      code === 'UPSTREAM_UNAVAILABLE' ||
      code === 'TEMP_ERROR' ||
      code === 'RATE_LIMITED' ||
      (status !== undefined && status >= 500) ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('network') ||
      lowerMsg.includes('temporar') ||
      lowerMsg.includes('econn') ||
      lowerMsg.includes('fetch failed'));

  return {
    code,
    message,
    adminRequired,
    authOrBind: brokerAuth.oauthRevoked || brokerAuth.notConnected || brokerAuth.unauthorized,
    tempError,
    offline,
    unavailable,
  };
}

export async function fetchGoogleStatus(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
): Promise<GoogleStatusSnapshot> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'GET',
    path: '/api/google/status',
  });
  const data = unwrapEnvelope<GoogleStatusSnapshot>(raw);
  return {
    client: data?.client ?? { configured: false },
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
  };
}

export async function configureGoogleClient(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  input: { clientFile?: string; clientId?: string; clientSecret?: string },
): Promise<GoogleStatusSnapshot> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/configure',
    body: input,
  });
  const data = unwrapEnvelope<GoogleStatusSnapshot>(raw);
  return {
    client: data?.client ?? { configured: true },
    accounts: Array.isArray(data?.accounts) ? data.accounts : [],
  };
}

export async function startGoogleAuthorize(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  input: { choices: GoogleServiceChoice[]; account?: string },
): Promise<GoogleAuthFlowStart> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/authorize',
    body: input,
  });
  return unwrapEnvelope<GoogleAuthFlowStart>(raw);
}

export async function pollGoogleAuthFlow(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  flowId: string,
): Promise<GoogleAuthFlowStatus> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/flow',
    body: { flowId },
  });
  return unwrapEnvelope<GoogleAuthFlowStatus>(raw);
}

export async function cancelGoogleAuthFlow(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  flowId: string,
): Promise<void> {
  await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/cancel',
    body: { flowId },
  });
}

export async function checkGoogleAccount(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  account: string,
): Promise<GoogleAccountView | GoogleStatusSnapshot> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/check',
    body: { account },
  });
  return unwrapEnvelope<GoogleAccountView | GoogleStatusSnapshot>(raw);
}

export async function listGoogleRules(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  deviceId: string,
  botId: string,
): Promise<GoogleRuleDto[]> {
  const qs = `deviceId=${encodeURIComponent(deviceId)}&botId=${encodeURIComponent(botId)}`;
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'GET',
    path: `/api/google/rules?${qs}`,
  });
  const data = unwrapEnvelope<GoogleRuleDto[] | { rules?: GoogleRuleDto[] }>(raw);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rules)) return data.rules;
  return [];
}

export async function saveGoogleRule(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  rule: GoogleRuleDto,
): Promise<GoogleRuleDto> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/rules/save',
    body: rule,
  });
  return unwrapEnvelope<GoogleRuleDto>(raw);
}

export async function removeGoogleRule(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  input: { id: string; deviceId: string; botId: string },
): Promise<void> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/rules/remove',
    body: input,
  });
  unwrapEnvelope<unknown>(raw);
}

/**
 * Create a volatile target-Host RPC caller bound to a verified DesktopIdentity
 * (mirrors BotChats.tsx submitVaultUnlock / callShower without modifying transport types).
 */
export function createVerifiedHostRpcCaller(
  api: DesktopPanelApi,
  identity: DesktopIdentity | null,
  method: 'browserControl' | 'googleSetupControl',
  botId: string,
): (input: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (input: Record<string, unknown>) => {
    const current = api.identity;
    if (
      !identity ||
      !current ||
      !api.transportConnected ||
      current.profileId !== identity.profileId ||
      current.targetDeviceId !== identity.targetDeviceId ||
      current.kind !== identity.kind ||
      current.generation !== identity.generation
    ) {
      throw Object.assign(new Error('Target Host is not connected.'), { code: 'NOT_CONNECTED' });
    }
    const rawApi = api as unknown as {
      call: (id: DesktopIdentity, m: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    const result = await rawApi.call(identity, method, { ...input, botId });
    return (asRecord(result) ?? {}) as Record<string, unknown>;
  };
}

export function createBrowserControlRequest(
  api: DesktopPanelApi,
  identity: DesktopIdentity | null,
  botId: string,
): BotBrowserControlCall {
  return createVerifiedHostRpcCaller(api, identity, 'browserControl', botId);
}

export function createGoogleSetupControlRequest(
  api: DesktopPanelApi,
  identity: DesktopIdentity | null,
  botId: string,
): GoogleSetupControlCall {
  const call = createVerifiedHostRpcCaller(api, identity, 'googleSetupControl', botId);
  return async (input: Record<string, unknown>): Promise<GoogleSetupControlState> => {
    const res = await call(input);
    return res as unknown as GoogleSetupControlState;
  };
}
