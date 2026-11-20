import type {
  BrowserControlInput,
  BrowserControlResult,
  DesktopIdentity,
  DesktopPanelApi,
  GoogleSetupControlInput,
  GoogleSetupControlResult,
} from '../../../desktop/web/src/types';
import { centerAdminRequest } from './centerAdminBroker';

export type PrivateBotControlMethod = 'browserControl' | 'googleSetupControl';

export interface MobileOrDesktopControlTarget {
  hostKind: 'local' | 'remote';
  botId: string;
  scopeId?: string;
  /** Local Android Host call adapter (e.g. BotHost.call). */
  callLocal?: (method: PrivateBotControlMethod, params: Record<string, unknown>) => Promise<unknown>;
  /** Desktop or Android remote panel API. */
  api?: DesktopPanelApi | null;
  /** Frozen target device identity from api.identityForTarget(deviceId). */
  identity?: DesktopIdentity | null;
}

function stripForbiddenClientFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'authority' || key === 'actor' || key === 'caller' || key === 'trusted' || key === 'owner') {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Bind a BotBrowserPanel `request` callback to volatile `browserControl` on the
 * frozen target device identity (never routes through chat/pending outbox).
 */
export function bindDesktopBrowserControl(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  botId: string,
  scopeId?: string,
): (input: Record<string, unknown>) => Promise<BrowserControlResult> {
  return (input: Record<string, unknown>) => {
    const payload = {
      ...stripForbiddenClientFields(input),
      botId,
      ...(scopeId !== undefined ? { scopeId } : {}),
    } as BrowserControlInput;
    return api.call(identity, 'browserControl', payload);
  };
}

/**
 * Bind a Google setup wizard `request` callback to volatile `googleSetupControl`
 * on the frozen target device identity (never routes through chat/pending outbox).
 */
export function bindDesktopGoogleSetupControl(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  botId: string,
  scopeId?: string,
): (input: Record<string, unknown>) => Promise<GoogleSetupControlResult> {
  return (input: Record<string, unknown>) => {
    const payload = {
      ...stripForbiddenClientFields(input),
      botId,
      ...(scopeId !== undefined ? { scopeId } : {}),
    } as GoogleSetupControlInput;
    return api.call(identity, 'googleSetupControl', payload);
  };
}

/**
 * Bind a cross-platform (Android local Host or Desktop/Android remote Host)
 * private control requester for browserControl or googleSetupControl.
 */
export function bindPrivateBotControl(
  target: MobileOrDesktopControlTarget,
  method: 'browserControl',
): (input: Record<string, unknown>) => Promise<BrowserControlResult>;
export function bindPrivateBotControl(
  target: MobileOrDesktopControlTarget,
  method: 'googleSetupControl',
): (input: Record<string, unknown>) => Promise<GoogleSetupControlResult>;
export function bindPrivateBotControl(
  target: MobileOrDesktopControlTarget,
  method: PrivateBotControlMethod,
): (input: Record<string, unknown>) => Promise<BrowserControlResult | GoogleSetupControlResult> {
  return (input: Record<string, unknown>) => {
    const payload = {
      ...stripForbiddenClientFields(input),
      botId: target.botId,
      ...(target.scopeId !== undefined ? { scopeId: target.scopeId } : {}),
    };
    if (target.hostKind === 'local') {
      if (typeof target.callLocal !== 'function') {
        return Promise.reject({ code: 'OFFLINE', outcome: 'not-sent', message: 'local host control is unavailable' });
      }
      return target.callLocal(method, payload) as Promise<BrowserControlResult | GoogleSetupControlResult>;
    }
    if (!target.api || !target.identity || !target.api.transportConnected) {
      return Promise.reject({ code: 'NOT_CONNECTED', outcome: 'not-sent', message: 'remote host transport is disconnected' });
    }
    if (method === 'browserControl') {
      return target.api.call(target.identity, 'browserControl', payload as BrowserControlInput);
    }
    return target.api.call(target.identity, 'googleSetupControl', payload as GoogleSetupControlInput);
  };
}

/**
 * Call Center's authenticated owner `/api/google/*` control plane through the
 * existing `center_admin_request` broker (never embeds master credentials or
 * OAuth callbacks in chat).
 */
export function googleOwnerCenterRequest<T = unknown>(
  api: DesktopPanelApi,
  identity: DesktopIdentity,
  params: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
  },
): Promise<T> {
  if (!params.path.startsWith('/api/google/')) {
    return Promise.reject({
      code: 'INVALID_ARGUMENT',
      outcome: 'not-sent',
      message: 'googleOwnerCenterRequest path must stay under /api/google/',
    });
  }
  return centerAdminRequest<T>(api, identity, params);
}
