// Minimal Center adapter over pinned vendored Orca Google scopes, readiness, and Workspace API.
//
// Directly depends on `./orca-domain.js` and `./vendor/orca/src/shared/google/google-scopes.ts`
// (stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea, MIT License, Copyright (c) 2026 Lovecast Inc.).
// Fixed Google API origins/paths, manual redirect refusal (no Bearer forwarding), download byte
// caps, and single HTTP 401 refresh retry are enforced by the single real `orca-domain.js` path.

import { createWorkspaceApi, loadOrca } from './orca-domain.js';

export {
  GOOGLE_BASE_SCOPES,
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICES,
  GOOGLE_SERVICE_CHOICES,
  GOOGLE_SERVICE_INFO,
  googleApiEnableUrl,
  googleChoiceServices,
  googleChoices,
  googleSignInScopes,
  grantedGoogleChoices,
} from './vendor/orca/src/shared/google/google-scopes.ts';

export { GoogleToolError } from './orca-domain.js';

/**
 * Probes per-service readiness through vendored `google-readiness.checkGoogleServices`.
 * Fails closed if the vendored readiness module cannot be loaded.
 */
export async function checkGoogleServices(args) {
  const modules = await loadOrca();
  const check = modules['google-readiness']?.checkGoogleServices;
  if (typeof check !== 'function') {
    throw new Error('Vendored google-readiness.checkGoogleServices is unavailable.');
  }
  return check(args);
}

/**
 * Builds an upstream-compatible GoogleApi via `orca-domain.js`'s `createWorkspaceApi`,
 * attaching the account's stable Center logical `id` alongside `email`.
 */
export function buildGoogleWorkspaceApi({ email, id, projectId, getAccessToken, fetchImpl }) {
  const api = createWorkspaceApi({
    email,
    ...(projectId ? { projectId } : {}),
    getAccessToken,
    fetchImpl,
  });
  return {
    ...api,
    id,
  };
}
