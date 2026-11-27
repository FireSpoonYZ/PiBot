# Vendored Antigravity ACP Engine

Adapted from upstream [`@estebanforge/pi-antigravity-bridge`](https://www.npmjs.com/package/@estebanforge/pi-antigravity-bridge):

- **Upstream version**: `1.10.6`
- **Upstream gitHead**: `d3ca5cc66947a3299e2ef18b8986c7dc86e9373b`
- **License**: MIT ([LICENSE](./LICENSE), Copyright (c) 2026 EstebanForge)

## Copied Files

- `LICENSE` <- `LICENSE`
- `driver-types.ts` <- `src/driver-types.ts`
- `frame-guard.ts` <- `src/frame-guard.ts`
- `redact.ts` <- `src/redact.ts`
- `stream-events.ts` <- `src/stream-events.ts`
- `stream-sanitizer.ts` <- `src/stream-sanitizer.ts`
- `acp/connection.ts` <- `src/acp/connection.ts`
- `acp/driver.ts` <- `src/acp/driver.ts`
- `acp/events.ts` <- `src/acp/events.ts`
- `acp/jsonrpc.ts` <- `src/acp/jsonrpc.ts`
- `acp/tool-image-hook.ts` and `acp/tool-image-hook-client.cjs` are adapted from `src/acp/recall-hook.ts` and `src/acp/recall-hook-client.cjs` in `@firespoon/pi-antigravity-bridge` `1.10.11` (`04f72f47558d5496fd3d2b56113ac90aebf2380e`) under the same MIT license, narrowed specifically to `PreInvocation` tool-result image delivery.
- `acp/usage-estimate.ts` <- `src/acp/usage-estimate.ts`

## Adaptations for `center-server`

1. **Node 26 native TypeScript execution**: Updated relative module specifiers from `.js` to `.ts`, kept type-only imports explicit (`import type`), and defined `UsageEstimate` directly in `driver-types.ts` instead of copying Pi CLI's `src/config.ts`.
2. **Isolated Center profile (`--gemini-dir`)**: Removed `src/acp/home.ts` (which created symlinks into `~/.gemini/antigravity-cli` and filtered global `mcp_config.json`). Replaced `isolateHome` in `acp/connection.ts` and `acp/driver.ts` with explicit `geminiDir` forwarding (`--gemini-dir <geminiDir>`).
3. **Permission policy inspection**: Passed `AcpPermissionRequest` into `AcpConnectionOptions.permissions(req)` and `AcpDriverOptions.permissionPolicy(req)` (expanding `toolCall` with optional `name` and `_meta`) so `center-server` can deny individual non-bridge permission requests.
4. **Bridge server prefix matching**: Extended `nativeMcpTool` in `acp/events.ts` to match both `pibot-bridge` and `pi-bridge` MCP server prefixes.
5. **Typed auth error & deterministic child exit**: Added `readonly code = "UNAUTHENTICATED"` on `AcpAuthError`, exposed `AcpConnection.waitForExit()`, and awaited spawned child termination in `AcpDriver.close()` without altering upstream cancel/kill teardown semantics.

## Current PiBot integration

See [the provider contract](../README.md) for native-turn execution, tool ownership, memory policy, and recovery boundaries. AGY autoRecall is disabled; PiBot uses `acp/tool-image-hook.ts` exclusively for `PreInvocation` tool-result image delivery so screenshots above `agy`'s MCP media offload threshold remain readable in the isolated Center agent.
