import {
  CenterApiError,
  createFetchCenterTransport,
} from '../web/src/center-admin';
import type {
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
} from '../web/src/center-admin';
import type {
  ApiError,
  LoginRequest,
  SessionInfo,
} from '@e-launcher/center-contract';

export interface SetupStatus {
  required: boolean;
  publicUrl?: string;
  linkUrl?: string;
  tlsMode?: 'direct' | 'proxy';
}

export interface SetupRequest {
  setupToken: string;
  ownerPassword: string;
  publicUrl: string;
}

export const webTransport = createFetchCenterTransport();
export { CenterApiError, createFetchCenterTransport };
export type {
  LoginRequest,
  QrLoginChallengeResponse,
  QrLoginClaimResponse,
  SessionInfo,
};

const id = encodeURIComponent;

function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  return webTransport.request<T>(method, path, body);
}

// Onboarding runs before any session exists, so /api/setup uses a raw fetch:
// no CSRF token is required or available yet. A 404 on GET means an older
// center without onboarding — already configured; POST 404 is a real error.
// Every request is bounded by SETUP_REQUEST_TIMEOUT_MS; a caller-provided
// signal is merged in, so an earlier caller abort (wait deadline) still wins.
const SETUP_REQUEST_TIMEOUT_MS = 10_000;

async function setupRequest<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort);
  const timer = setTimeout(() => controller.abort(), SETUP_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/setup', {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === 'GET' && response.status === 404) return { required: false } as T;
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as ApiError | null;
      throw new CenterApiError(
        payload?.error?.code || 'HTTP_ERROR',
        payload?.error?.message || `请求失败 (${response.status})`,
        response.status,
        payload?.error?.details,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export const api = {
  getSetup: (signal?: AbortSignal) => setupRequest<SetupStatus>('GET', undefined, signal),
  submitSetup: (body: SetupRequest) => setupRequest<{ configured: boolean }>('POST', body),
  async session() {
    const result = await request<SessionInfo>('/api/session');
    webTransport.setCsrfToken(result.csrfToken);
    return result;
  },
  async login(body: LoginRequest) {
    const result = await request<SessionInfo>('/api/session', 'POST', body);
    webTransport.setCsrfToken(result.csrfToken);
    return result;
  },
  async logout() {
    await request<void>('/api/session', 'DELETE');
    webTransport.setCsrfToken(null);
  },
  createQrLogin: () => request<QrLoginChallengeResponse>('/api/session/qr', 'POST', {}),
  async claimQrLogin(challengeId: string, browserSecret: string) {
    const result = await request<QrLoginClaimResponse>(
      `/api/session/qr/${id(challengeId)}/claim`,
      'POST',
      { browserSecret },
    );
    if (result.status === 'approved' && result.csrfToken) {
      webTransport.setCsrfToken(result.csrfToken);
    }
    return result;
  },
};
