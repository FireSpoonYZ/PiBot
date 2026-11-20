// Center Google Workspace domain bridge backed by pinned vendored Orca MIT modules.
//
// Exports:
//   - loadOrca(): Promise<Record<string, Record<string, unknown>>>
//     Returns a frozen namespace map keyed by each upstream TS file's basename (without `.ts`),
//     preserving all upstream exported method, schema, and constant names.
//   - createWorkspaceApi({ email, projectId?, getAccessToken, fetchImpl?, timeoutMs? }): GoogleApi
//     Upstream-compatible `{ email, get, find, send, bytes }` client with fixed Google API origin
//     and path validation, manual redirect refusal (no Bearer forwarding), bounded download bytes,
//     single HTTP 401 refresh retry, and no blind retry on timed-out/network-failed writes.
//   - GoogleToolError, parseGoogleJson, failureSentence, ALLOWED_GOOGLE_API_ORIGINS,
//     SERVICE_ALLOWED_ORIGINS, assertAllowedGoogleApiUrl, ORCA_UPSTREAM, ORCA_MODULE_PATHS.

import {
  ALLOWED_GOOGLE_API_ORIGINS,
  assertAllowedGoogleApiUrl,
  createWorkspaceApi,
  failureSentence,
  GoogleToolError,
  parseGoogleJson,
  SERVICE_ALLOWED_ORIGINS
} from './vendor/orca/src/main/google/google-api-client.ts'

export const ORCA_UPSTREAM = Object.freeze({
  repo: 'https://github.com/stablyai/orca',
  version: 'v1.4.265',
  commit: 'e64e561738d8d465ab459e7e3f9e46d08b6396ea',
  license: 'MIT'
})

export const ORCA_MODULE_PATHS = Object.freeze({
  // Core API client, readiness probes, and OAuth token endpoint
  'google-api-client': './vendor/orca/src/main/google/google-api-client.ts',
  'google-readiness': './vendor/orca/src/main/google/google-readiness.ts',
  'google-token-endpoint': './vendor/orca/src/main/google/google-token-endpoint.ts',

  // Gmail read/write/changes/MIME/HTML
  'gmail-mime-message': './vendor/orca/src/main/google/gmail-mime-message.ts',
  'google-html-text': './vendor/orca/src/main/google/google-html-text.ts',
  'google-gmail-message': './vendor/orca/src/main/google/google-gmail-message.ts',
  'google-gmail-read': './vendor/orca/src/main/google/google-gmail-read.ts',
  'google-gmail-draft-compose': './vendor/orca/src/main/google/google-gmail-draft-compose.ts',
  'google-gmail-write': './vendor/orca/src/main/google/google-gmail-write.ts',
  'google-gmail-changes': './vendor/orca/src/main/google/google-gmail-changes.ts',

  // Calendar read/write/free-time/changes/time-zone
  'google-time-zone': './vendor/orca/src/main/google/google-time-zone.ts',
  'google-event-time': './vendor/orca/src/main/google/google-event-time.ts',
  'google-calendar-read': './vendor/orca/src/main/google/google-calendar-read.ts',
  'google-calendar-event-target': './vendor/orca/src/main/google/google-calendar-event-target.ts',
  'google-calendar-free-time': './vendor/orca/src/main/google/google-calendar-free-time.ts',
  'google-calendar-write': './vendor/orca/src/main/google/google-calendar-write.ts',
  'google-calendar-changes': './vendor/orca/src/main/google/google-calendar-changes.ts',

  // Contacts (People API)
  'google-contacts-read': './vendor/orca/src/main/google/google-contacts-read.ts',

  // Drive, Docs, Sheets, and bounded PDF text extraction
  'google-drive-files': './vendor/orca/src/main/google/google-drive-files.ts',
  'google-drive-text-cache': './vendor/orca/src/main/google/google-drive-text-cache.ts',
  'google-drive-read': './vendor/orca/src/main/google/google-drive-read.ts',
  'google-drive': './vendor/orca/src/main/google/google-drive.ts',
  'google-docs-text': './vendor/orca/src/main/google/google-docs-text.ts',
  'google-docs-markdown': './vendor/orca/src/main/google/google-docs-markdown.ts',
  'google-docs-comments': './vendor/orca/src/main/google/google-docs-comments.ts',
  'google-docs': './vendor/orca/src/main/google/google-docs.ts',
  'google-sheets': './vendor/orca/src/main/google/google-sheets.ts',
  'google-pdf-text': './vendor/orca/src/main/google/google-pdf-text.ts',
  'google-pdf-text-client': './vendor/orca/src/main/google/google-pdf-text-client.ts',
  'google-pdf-text-worker-protocol':
    './vendor/orca/src/main/google/google-pdf-text-worker-protocol.ts',

  // Triggers & pure trigger state
  'google-trigger-match': './vendor/orca/src/main/google/google-trigger-match.ts',
  'google-trigger-checker': './vendor/orca/src/main/google/google-trigger-checker.ts',
  'google-trigger-state': './vendor/orca/src/main/google/google-trigger-state.ts',

  // Output formatters with untrusted content fencing
  'google-read-format': './vendor/orca/src/cli/google/google-read-format.ts',
  'google-write-format': './vendor/orca/src/cli/google/google-write-format.ts',
  'google-files-format': './vendor/orca/src/cli/google/google-files-format.ts',

  // Shared scopes, types, A1 notation, RFC 5322 addresses, budgets, fencing, and RPC schemas
  'google-scopes': './vendor/orca/src/shared/google/google-scopes.ts',
  'google-connect-types': './vendor/orca/src/shared/google/google-connect-types.ts',
  'google-client-config': './vendor/orca/src/shared/google/google-client-config.ts',
  'google-read-types': './vendor/orca/src/shared/google/google-read-types.ts',
  'google-write-types': './vendor/orca/src/shared/google/google-write-types.ts',
  'google-files-types': './vendor/orca/src/shared/google/google-files-types.ts',
  'email-address-list': './vendor/orca/src/shared/google/email-address-list.ts',
  'gmail-draft-request-budget': './vendor/orca/src/shared/google/gmail-draft-request-budget.ts',
  'sheets-a1': './vendor/orca/src/shared/google/sheets-a1.ts',
  'tool-output-limits': './vendor/orca/src/shared/tool-output-limits.ts',
  'quoted-text-fence': './vendor/orca/src/shared/quoted-text-fence.ts',
  'automation-google-triggers': './vendor/orca/src/shared/automation-google-triggers.ts',
  'automation-event-triggers': './vendor/orca/src/shared/automation-event-triggers.ts',
  'automation-definition': './vendor/orca/src/shared/automations/automation-definition.ts',
  'bot-types': './vendor/orca/src/shared/bot-types.ts',
  'host-account-sign-in-types':
    './vendor/orca/src/shared/agent-accounts/host-account-sign-in-types.ts',
  'image-mime-types': './vendor/orca/src/shared/file-preview/image-mime-types.ts',
  'media-mime-types': './vendor/orca/src/shared/file-preview/media-mime-types.ts',
  'file-preview-kind': './vendor/orca/src/shared/file-preview/file-preview-kind.ts',
  'paired-request-budget': './vendor/orca/src/shared/remote-runtime/paired-request-budget.ts',
  'google-call-params': './vendor/orca/src/shared/rpc-contract/google-call-params.ts',
  'google-read-params': './vendor/orca/src/shared/rpc-contract/google-read-params.ts',
  'google-write-params': './vendor/orca/src/shared/rpc-contract/google-write-params.ts',
  'google-files-params': './vendor/orca/src/shared/rpc-contract/google-files-params.ts'
})

let cachedOrcaPromise = null

/**
 * Loads all vendored Orca Google Workspace domain modules keyed by upstream TS basename
 * (without `.ts`). The returned map is frozen and cached across calls.
 */
export async function loadOrca() {
  if (!cachedOrcaPromise) {
    cachedOrcaPromise = (async () => {
      const entries = await Promise.all(
        Object.entries(ORCA_MODULE_PATHS).map(async ([name, specifier]) => {
          const ns = await import(specifier)
          return [name, ns]
        })
      )
      return Object.freeze(Object.fromEntries(entries))
    })().catch((error) => {
      cachedOrcaPromise = null
      throw error
    })
  }
  return cachedOrcaPromise
}

export {
  ALLOWED_GOOGLE_API_ORIGINS,
  assertAllowedGoogleApiUrl,
  createWorkspaceApi,
  failureSentence,
  GoogleToolError,
  parseGoogleJson,
  SERVICE_ALLOWED_ORIGINS
}
