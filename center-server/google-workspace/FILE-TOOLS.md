# Google Workspace File Tools & Host File-Transfer Hooks

This document describes the integration contract between:
- `center-server/google-workspace/file-tools.js` (Center MCP tools for Drive, Docs, and Sheets)
- `host-core/google-file-transfer.js` (Host pre/post hooks for workspace files and attachments, including Gmail)

## 1. Center Tool Registration (`center-server/google-workspace/file-tools.js`)

Exports:
- `fileTools`: array of 18 MCP tool definitions:
  - Drive: `drive_search`, `drive_list`, `drive_read`, `drive_download`, `drive_upload`, `drive_mkdir`, `drive_move`, `drive_share`
  - Docs: `docs_read`, `docs_create`, `docs_append`, `docs_replace`, `docs_comment`
  - Sheets: `sheets_create`, `sheets_read`, `sheets_write`, `sheets_append`, `sheets_upsert`
- `createFileTools({ loadOrca }?)`: factory accepting a custom `loadOrca` loader (defaults to `./orca-domain.js`).
- `FILE_TOOL_NAMES`, `DRIVE_UPLOAD_MAX_BYTES` (583,584), `PAIRED_REQUEST_PARAMS_MAX_BYTES` (782,208), `TOOL_DOWNLOAD_MAX_BYTES` (2,900,000), `ASKED_BY_MAX_CHARS` (140).

Each tool has shape:
```js
{
  name: string,
  description: string,
  inputSchema: JsonSchema, // accepts optional `account`, additionalProperties: false, no caller/actor fields
  run: async (args, { api, signal, askedBy }) => businessResult,
}
```

### Center Gateway Responsibilities
1. Resolve the Google account on Center from `args.account` (or single connected account; prompt user to choose when multiple accounts exist and `account` is omitted) and construct `api` via `accounts.api(args.account)`.
2. Compute trusted `askedBy` server-side from verified caller/turn metadata when applicable; never accept `askedBy`, `caller`, `actor`, `botToken`, or `callerSessionId` from model arguments (`file-tools.js` rejects all unknown keys).
3. Never read or write local filesystem paths on Center:
   - `drive_upload.run()` explicitly rejects any call that still carries `args.path`; it requires Host-staged `{ name, data }`.
   - `drive_download.run()` returns upstream `{ file, name, data }` (base64) to the authenticated Host caller; Center does not touch `args.out`.
4. Ensure `orca-domain.js` exposes `modules['google-drive']`, `modules['google-drive-read']`, `modules['google-docs']`, and `modules['google-sheets']` from `await loadOrca()`.

## 2. Host MCP Pre/Post Call Hooks (`host-core/google-file-transfer.js`)

In the trusted Host MCP execution path (for example `host-core/capabilities/mcp.js` when `target === 'center'` and the capability is the builtin Google Workspace MCP), wrap `host.centerClient.callCapabilityTool(...)` with:

```js
import {
  prepareGoogleFileCall,
  finishGoogleFileCall,
} from '../google-file-transfer.js';

// Resolve Bot workspace & attachment store from trusted Host state (never from model args):
const bot = host.host.getBot(botId);
const transferOptions = {
  cwd: bot.cwd,
  dataRoot: host.host.dataRoot, // optional; enables attachment://<sha256> and bot-files integration
  botId,                        // optional; required together with dataRoot for attachment:// refs
  signal,
};

// 1. BEFORE calling Center (does NOT mutate original `args`):
const centerArgs = await prepareGoogleFileCall(tool.name, args, transferOptions);

// 2. Call Center over authenticated device channel:
const rawResult = await host.centerClient.callCapabilityTool(
  installationId,
  botId,
  tool.name,
  centerArgs,
  api.callId,
  { signal },
);

// 3. AFTER receiving Center result (pass original `args` so `args.out` is available on Host):
const safeResult = await finishGoogleFileCall(tool.name, rawResult, {
  ...transferOptions,
  args,
});

// 4. Convert sanitized result for the LLM (guaranteed free of base64 binary payloads):
return { output: toLlmContent(safeResult), isError: safeResult.isError === true };
```

### Hook Behavior Summary
- **`prepareGoogleFileCall(name, args, { cwd, dataRoot?, botId?, signal? })`**:
  - `drive_upload`: rejects model-supplied raw `data`; resolves `args.path` strictly inside canonical `cwd` (or `attachment://<sha256>` / `<dataRoot>/attachments/<botId>/files/` when `dataRoot` + `botId` are supplied), enforces symlink containment, `O_NOFOLLOW`, regular file check, bounded read `<= 583,584 B`, and JSON budget `<= 782,208 B`; returns new args `{ ...rest, name, data }` with `path` removed.
  - `gmail_draft`: accepts `attachments` (`string[]` or `{ path, name? }[]`) and/or `attach`; rejects model-supplied raw `data`; enforces max 20 attachments, shared `562,080 B` raw byte budget, and total JSON budget `<= 782,208 B`; returns new args with `attachments: [{ name, data }]` and `attach` removed.
  - `drive_download`, `gmail_attachment`, `gmail_read` (with `download`/`out`): pre-validates optional `args.out` against canonical `cwd` (refuses escape, symlinks, reserved Windows names, and existing files) and strips `out` from forwarded args without mutating caller `args`.
  - Optional Host-side `bodyFile` / `pairsFile` / `valuesFile` staging for Docs/Sheets/Gmail draft tools (refuses conflicting inline + file fields, enforces workspace containment and `782,208 B` budget, strips `*File`).
  - Pass-through for all other tools.
- **`finishGoogleFileCall(name, result, { cwd, args, dataRoot?, botId?, signal? })`**:
  - Handles raw business objects and MCP `CallToolResult` (`content` JSON text and/or `structuredContent`) for `drive_download`, `gmail_attachment`, and `gmail_read` attachment payloads.
  - Passes `isError: true` results through without writing to disk.
  - Validates canonical base64 and `<= 2,900,000 B` cap, computes SHA-256, and writes atomically (`0o600` temp file + non-overwriting `link`/`O_EXCL`):
    - With `args.out`: writes strictly inside canonical `cwd`, refusing symlink traversal and existing targets (`FILE_EXISTS`).
    - Without `args.out`:
      - Valid JPEG/PNG with `dataRoot` + `botId`: stores via `host-core/attachments.js` `uploadAttachment()` and returns `attachmentRef: "attachment://<sha256>"` (no raw `dataRoot` disk path leaked).
      - Other files (or without `dataRoot`/`botId`): stores content-addressed under `<cwd>/.google-downloads/<sha256>/<safeName>` with SHA-256 deduplication (`deduplicated: true`) and tamper detection (`REQUEST_CONFLICT`).
  - Strips `data` (base64) completely from all output layers before returning to the model/chat.
