/*
 * Center adapter over pinned vendored Orca trigger modules (`./orca-domain.js` and `./vendor/orca/`).
 * Source: stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (v1.4.265).
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { GoogleToolError, loadOrca } from './orca-domain.js';
import {
  assertGoogleTrigger as orcaAssertGoogleTrigger,
  GOOGLE_EVENT_SOURCES,
  isGoogleTrigger,
  MAX_MINUTES_BEFORE,
} from './vendor/orca/src/shared/automation-google-triggers.ts';

export {
  GOOGLE_EVENT_SOURCES,
  GoogleToolError,
  isGoogleTrigger,
  MAX_MINUTES_BEFORE,
};
export {
  calendarDueAt,
  calendarRunEvent,
  gmailRuleMatches,
  gmailRunEvent,
} from './vendor/orca/src/main/google/google-trigger-match.ts';
export {
  mailboxAddress,
  mailboxAddresses,
  splitAddresses,
} from './vendor/orca/src/shared/google/email-address-list.ts';

// Pinned Orca filter caps and GoogleTriggerChecker scheduling/backoff constants.
export const MAX_FILTER_LENGTH = 200;
export const MAX_ADDRESSES = 10;
export const SCHEDULE_MAX_AGE_MS = 30 * 60_000;
export const SEED_RETRY_MS = 60 * 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 60_000;
export const ERROR_BACKOFF_MS = 5 * 60_000;
export const MAX_REMEMBERED_FIRES = 500;
export const DEFAULT_TICK_MS = 60_000;

export function assertGoogleTrigger(trigger) {
  if (!isGoogleTrigger(trigger)) {
    throw Object.assign(new Error('Unsupported Google trigger source.'), { code: 'INVALID_ARGUMENT' });
  }
  try {
    orcaAssertGoogleTrigger(trigger);
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      code: 'INVALID_ARGUMENT',
    });
  }
}

export function httpStatusOf(error) {
  if (!error || typeof error !== 'object') return null;
  if (Number.isInteger(error.status)) return error.status;
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  return null;
}

export function classifyCheckError(error) {
  const status = httpStatusOf(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  const msg = typeof error?.message === 'string' ? error.message : '';
  const lower = msg.toLowerCase();

  if (
    code === 'GOOGLE_ACCOUNT_NOT_FOUND'
    || code === 'ACCOUNT_NOT_FOUND'
    || /isn't connected|not connected|account not found/.test(lower)
  ) {
    return {
      status: 'paused_account_missing',
      reason: 'ACCOUNT_NOT_FOUND',
      detail: 'Google account is no longer connected.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  if (
    status === 401
    || code === 'GOOGLE_RECONNECT_REQUIRED'
    || code === 'RECONNECT_REQUIRED'
    || code === 'INVALID_GRANT'
    || /invalid_grant|reconnect|sign-in|access ended/.test(lower)
  ) {
    return {
      status: 'paused_account_reconnect',
      reason: 'RECONNECT_REQUIRED',
      detail: 'Google authorization expired or was revoked. Reconnect this account.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  if (status === 429 || code === 'RATE_LIMITED' || /too many requests|rate limit/.test(lower)) {
    return {
      status: 'backing_off',
      reason: 'RATE_LIMITED',
      detail: 'Google API rate limit reached; backing off before retrying.',
      rateLimited: true,
      baseBackoffMs: RATE_LIMIT_BACKOFF_MS,
    };
  }
  if (
    status === 403
    || code === 'GOOGLE_API_DISABLED'
    || code === 'GOOGLE_NEEDS_PERMISSION'
    || code === 'GOOGLE_BLOCKED_BY_ADMIN'
  ) {
    if (code === 'GOOGLE_API_DISABLED' || /api is turned off|not been used|api.*disabled/.test(lower)) {
      return {
        status: 'paused_service_unavailable',
        reason: 'API_DISABLED',
        detail: 'Required Google API is not enabled in the Cloud project.',
        rateLimited: false,
        baseBackoffMs: ERROR_BACKOFF_MS,
      };
    }
    if (code === 'GOOGLE_BLOCKED_BY_ADMIN' || /admin blocked|blocked by.*admin/.test(lower)) {
      return {
        status: 'paused_service_unavailable',
        reason: 'BLOCKED_BY_ADMIN',
        detail: 'Access to this Google service is blocked by the organization administrator.',
        rateLimited: false,
        baseBackoffMs: ERROR_BACKOFF_MS,
      };
    }
    return {
      status: 'paused_service_unavailable',
      reason: 'NEEDS_PERMISSION',
      detail: 'Google permission for this service has not been granted.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  return {
    status: 'backing_off',
    reason: 'CHECK_ERROR',
    detail: 'Temporary error while checking Google; retrying after backoff.',
    rateLimited: false,
    baseBackoffMs: ERROR_BACKOFF_MS,
  };
}

function requireFn(mod, modName, fnName) {
  const fn = mod?.[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`Vendored ${modName}.${fnName} is unavailable.`);
  }
  return fn;
}

/**
 * Resolves trigger operations directly from pinned vendored `orca-domain.js` (`loadOrca()`).
 * Fails closed if required vendored modules are unavailable.
 */
export async function resolveOrcaTriggerOps(loadOrcaOverride) {
  const modules = typeof loadOrcaOverride === 'function'
    ? await loadOrcaOverride()
    : await loadOrca();
  if (!modules || typeof modules !== 'object') {
    throw new Error('Vendored Orca domain modules are unavailable.');
  }

  const gmailChangesMod = modules['google-gmail-changes'];
  const calChangesMod = modules['google-calendar-changes'];
  const matchMod = modules['google-trigger-match'];
  const triggersMod = modules['automation-google-triggers'];

  const rawAssertTrigger = requireFn(triggersMod, 'automation-google-triggers', 'assertGoogleTrigger');
  const rawCalendarChangedSince = requireFn(calChangesMod, 'google-calendar-changes', 'calendarChangedSince');

  return {
    assertGoogleTrigger: (trigger) => {
      if (!isGoogleTrigger(trigger)) {
        throw Object.assign(new Error('Unsupported Google trigger source.'), { code: 'INVALID_ARGUMENT' });
      }
      try {
        rawAssertTrigger(trigger);
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          code: 'INVALID_ARGUMENT',
        });
      }
    },
    gmailHistoryNow: requireFn(gmailChangesMod, 'google-gmail-changes', 'gmailHistoryNow'),
    gmailChangesSince: requireFn(gmailChangesMod, 'google-gmail-changes', 'gmailChangesSince'),
    gmailLabelIds: requireFn(gmailChangesMod, 'google-gmail-changes', 'gmailLabelIds'),
    // Preserve HTTP 410 syncToken re-seed even if an upstream/test caller surfaces a duck-typed 410 error.
    calendarChangedSince: async (api, calendarId, syncToken) => {
      try {
        return await rawCalendarChangedSince(api, calendarId, syncToken);
      } catch (error) {
        if (syncToken && httpStatusOf(error) === 410) {
          return await rawCalendarChangedSince(api, calendarId, undefined);
        }
        throw error;
      }
    },
    upcomingEvents: requireFn(calChangesMod, 'google-calendar-changes', 'upcomingEvents'),
    gmailRuleMatches: requireFn(matchMod, 'google-trigger-match', 'gmailRuleMatches'),
    gmailRunEvent: requireFn(matchMod, 'google-trigger-match', 'gmailRunEvent'),
    calendarDueAt: requireFn(matchMod, 'google-trigger-match', 'calendarDueAt'),
    calendarRunEvent: requireFn(matchMod, 'google-trigger-match', 'calendarRunEvent'),
  };
}
