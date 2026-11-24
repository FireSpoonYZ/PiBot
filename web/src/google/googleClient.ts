// Real owner-broker API client for Center Google Workspace & target-Host browser/setup volatile RPCs.
// Strictly aligned with center-server/google-workspace/{routes,accounts,rules}.js and host-core/browser-setup-protocol.js.
// Never sends secrets or OAuth codes through chat messages, drafts, or durable outboxes.
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { centerAdminRequest, errorCodeOf, isCenterAuthOrBindError } from '../bot-settings/centerAdminBroker';
import type {
  BotBrowserControlCall,
  GoogleAccountView,
  GoogleAssistantEventItem,
  GoogleAssistantEventsResponse,
  GoogleAssistantRemoveResponse,
  GoogleAssistantResponse,
  GoogleAssistantSaveRequest,
  GoogleAssistantSetupRequest,
  GoogleAssistantSetupResponse,
  GoogleAuthFlowStart,
  GoogleAuthFlowStatus,
  GoogleBotSyncSnapshot,
  GoogleRuleDto,
  GoogleServiceChoice,
  GoogleSetupControlCall,
  GoogleSetupControlState,
  GoogleStatusSnapshot,
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
  conflict: boolean;
  invalidArgument: boolean;
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
    code === 'SETUP_ADMIN_REQUIRED' ||
    status === 403 ||
    lowerMsg.includes('admin required') ||
    lowerMsg.includes('owner required');

  const conflict =
    code === 'REVISION_CONFLICT' ||
    code === 'SETUP_REVISION_CONFLICT' ||
    code === 'GOOGLE_SETUP_CONFLICT' ||
    code === 'REQUEST_CONFLICT' ||
    code === 'STALE_INPUT' ||
    status === 409;

  const invalidArgument = code === 'INVALID_ARGUMENT';

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
    code === 'GOOGLE_SETUP_UNAVAILABLE' ||
    status === 404 ||
    status === 501 ||
    lowerMsg.includes('not implemented') ||
    lowerMsg.includes('unknown method');

  const tempError =
    !adminRequired &&
    !conflict &&
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
    conflict,
    invalidArgument,
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
  input: { clientFile?: string; clientId?: string; clientSecret?: string; projectId?: string; ifUnconfigured?: true },
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
    body: account ? { account } : {},
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
  const data = unwrapEnvelope<GoogleRuleDto[] | { items?: GoogleRuleDto[]; rules?: GoogleRuleDto[] }>(raw);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.rules)) return data.rules;
  return [];
}

/** Build a strictly whitelisted payload matching center-server/google-workspace/rules.js SAVE_ALLOWED_FIELDS. */
export function buildGoogleRuleSaveBody(rule: GoogleRuleDto): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceId: rule.deviceId,
    botId: rule.botId,
    account: rule.account,
    source: rule.source,
    enabled: Boolean(rule.enabled),
    instruction: rule.instruction,
  };
  if (rule.id) body.id = rule.id;
  if (rule.name) body.name = rule.name;
  if (rule.source === 'gmail') {
    if (rule.from !== undefined && (Array.isArray(rule.from) ? rule.from.length > 0 : rule.from.trim().length > 0)) {
      body.from = rule.from;
    }
    if (rule.to !== undefined && (Array.isArray(rule.to) ? rule.to.length > 0 : rule.to.trim().length > 0)) {
      body.to = rule.to;
    }
    if (rule.subjectContains && rule.subjectContains.trim()) {
      body.subjectContains = rule.subjectContains.trim();
    }
    if (rule.label && rule.label.trim()) {
      body.label = rule.label.trim();
    }
  } else {
    body.calendar = rule.calendar && rule.calendar.trim() ? rule.calendar.trim() : 'primary';
    if (typeof rule.minutesBefore === 'number' && Number.isFinite(rule.minutesBefore)) {
      body.minutesBefore = Math.max(0, Math.min(1440, Math.round(rule.minutesBefore)));
    }
  }
  return body;
}

export async function saveGoogleRule(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  rule: GoogleRuleDto,
): Promise<GoogleRuleDto> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/rules/save',
    body: buildGoogleRuleSaveBody(rule),
  });
  const data = unwrapEnvelope<GoogleRuleDto | { rule?: GoogleRuleDto }>(raw);
  if (data && typeof data === 'object' && 'rule' in data && data.rule) {
    return data.rule;
  }
  return data as GoogleRuleDto;
}

/** Matches center-server/google-workspace/rules.js REMOVE_ALLOWED_FIELDS (`{ id }` only). */
export async function removeGoogleRule(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  input: { id: string },
): Promise<void> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/rules/remove',
    body: { id: input.id },
  });
  unwrapEnvelope<unknown>(raw);
}

export async function getGoogleAssistant(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
): Promise<GoogleAssistantResponse> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'GET',
    path: '/api/google/assistant',
  });
  const data = unwrapEnvelope<GoogleAssistantResponse>(raw);
  return {
    assistant: data?.assistant ?? null,
    runtime: data?.runtime ?? null,
  };
}

export const fetchGoogleAssistant = getGoogleAssistant;

export async function saveGoogleAssistant(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  body: GoogleAssistantSaveRequest,
): Promise<GoogleAssistantResponse> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/assistant/save',
    body,
  });
  const data = unwrapEnvelope<GoogleAssistantResponse>(raw);
  return {
    assistant: data?.assistant ?? null,
    runtime: data?.runtime ?? null,
  };
}

export async function setupGoogleAssistant(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  body: GoogleAssistantSetupRequest,
): Promise<GoogleAssistantSetupResponse> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/assistant/setup',
    body,
  });
  const data = unwrapEnvelope<GoogleAssistantSetupResponse>(raw);
  return {
    assistant: data?.assistant ?? null,
    runtime: data?.runtime ?? null,
    ...(data?.createdBot !== undefined ? { createdBot: data.createdBot } : {}),
  };
}

export async function removeGoogleAssistant(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
): Promise<GoogleAssistantRemoveResponse> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'POST',
    path: '/api/google/assistant/remove',
    body: {},
  });
  const data = unwrapEnvelope<GoogleAssistantRemoveResponse>(raw);
  return { removed: Boolean(data?.removed) };
}

export async function listGoogleAssistantEvents(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  limit?: number,
): Promise<GoogleAssistantEventsResponse> {
  const qs =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? `?limit=${Math.round(limit)}`
      : '';
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'GET',
    path: `/api/google/assistant/events${qs}`,
  });
  const data = unwrapEnvelope<GoogleAssistantEventsResponse | GoogleAssistantEventItem[]>(raw);
  if (Array.isArray(data)) return { items: data };
  return { items: Array.isArray(data?.items) ? data.items : [] };
}

export async function fetchGoogleBotSync(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
): Promise<GoogleBotSyncSnapshot> {
  const raw = await centerAdminRequest<unknown>(api, identity, {
    method: 'GET',
    path: '/api/bot-sync',
  });
  const data = unwrapEnvelope<Partial<GoogleBotSyncSnapshot>>(raw);
  return {
    devices: Array.isArray(data?.devices) ? data.devices : [],
    bots: Array.isArray(data?.bots) ? data.bots : [],
  };
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
