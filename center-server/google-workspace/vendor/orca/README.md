# Vendored Orca Google Workspace Domain Modules

Adapted from upstream [`stablyai/orca`](https://github.com/stablyai/orca):

- **Upstream version**: `v1.4.265`
- **Upstream commit**: `e64e561738d8d465ab459e7e3f9e46d08b6396ea`
- **License**: MIT ([LICENSE](./LICENSE), Copyright (c) 2026 Lovecast Inc.)
- **Provenance**: Exact upstream Git blob IDs and SHA-256 digests are recorded in [MANIFEST.json](./MANIFEST.json).

## Included Minimal Closure

- `src/main/google/`: Gmail read/write/draft-compose/changes/MIME/HTML, Calendar read/write/free-time/event-target/changes/time-zone, Contacts (People API), Drive/Docs/Sheets read/write/comments/markdown/cache, bounded PDF text extraction worker, readiness probes, OAuth token endpoint helpers, trigger matching/checker/pure state, and Center-adapted Google API client.
- `src/cli/google/`: Pure output formatters (`google-read-format.ts`, `google-write-format.ts`, `google-files-format.ts`) with untrusted content fencing.
- `src/shared/`: `google-scopes.ts`, Google read/write/files/connect/client types, RFC 5322 `email-address-list.ts`, `sheets-a1.ts`, `tool-output-limits.ts`, `quoted-text-fence.ts`, `automation-google-triggers.ts`, `gmail-draft-request-budget.ts`, MIME preview lookup, paired request budget constants, and RPC parameter schemas.

## Adaptations for `center-server`

1. **Node 24/26 native TypeScript execution**: Added explicit `.ts` extensions on relative module specifiers, preserved `import type` / `export type`, and converted constructor parameter properties in `GoogleTokenError` (`google-token-endpoint.ts`) and `GoogleTriggerChecker` (`google-trigger-checker.ts`) to explicit class fields so Node's native type-stripping loads every file without a separate build step in `node --test`, Docker, or DEB packages.
2. **Center-hosted `createWorkspaceApi` (`google-api-client.ts`)**: Removed Electron host-local credential/token store imports (`google-credential-store`, `google-account-tokens`) and exposed `createWorkspaceApi({ email, projectId, getAccessToken, fetchImpl })` with strict HTTPS origin + per-service path allowlisting, `redirect: 'manual'` refusal (preventing Bearer forwarding on redirects), single HTTP 401 refresh retry, no retry on network/timeout errors (protecting writes), and bounded `bytes()` streaming.
3. **Redirect hardening (`google-readiness.ts`, `google-token-endpoint.ts`)**: Added `redirect: 'manual'` and explicit 3xx refusal so Bearer tokens, PKCE verifiers, and client secrets are never forwarded across redirects.
4. **Bounded PDF text extraction (`google-pdf-text*.ts`)**: Replaced Electron's custom worker-thread helper utilities with a self-contained Node `worker_threads` queue (`new URL('./google-pdf-text-worker-entry.ts', import.meta.url)`), explicit byte/page/character/timeout bounds (`isEvalSupported: false`), unref'd idle teardown, and explicit errors if `pdfjs-dist` is unavailable or a PDF cannot be parsed (never swallowing errors to fake readability).
5. **Pure trigger state (`google-trigger-state.ts`)**: Removed Electron `getDataFile` dependency in favor of explicit paths with atomic temp-file + rename persistence and pure `emptyGoogleTriggerState` / `parseGoogleTriggerState` helpers.
6. **Minimal shared dependency extracts**: Extracted only the needed types and constants from `file-preview-kind.ts`, `paired-request-budget.ts`, `google-call-params.ts`, `host-account-sign-in-types.ts`, `automation-event-triggers.ts`, `automation-definition.ts`, and `bot-types.ts` so Electron, native raster decoders, remote-runtime RPC serializers, and non-Google cloud connectors are not pulled into `center-server`.
