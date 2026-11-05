# Capability installations — manage_bot_installation

`manage_bot_installation({deviceId, botId, action, ...})` manages capability packages (plugins, skills, MCP servers) through the same center services the management UI uses. Bot-scoped actions only ever touch the target Bot's binding; package-level shared changes require owner/admin authority.

Actions: `inspect | install | update | rollback | enable | disable | uninstall | operation | deployments`.

## Rules

- Mutations are compare-and-swap and carry `requestId`/operation ids: same request → same `operationId`, conflicting content → conflict error.
- 202-style acceptance is not deployment. An `operationId` means the work was accepted; poll `operation {operationId}` and `deployments` for device receipts — only an `applied`/`removed` phase plus a matching device receipt means done. `waiting-idle` means the device deferred it; `failed` is terminal for that operation. Never call a queued deploy success.
- Bot-scoped install creates the Bot's own binding; mutations that would rewrite shared package state outside the target Bot return an explicit error — that is the sign to use the admin surface, not to retry.
- `uninstall`/`disable` keep their terminal phase — they do not re-enter validation.

## Flows

Inspect: `inspect {installationId}` → package metadata, target version, binding, activation status (`enabling | enabled | disabled | failed`).

Install for a Bot: `install {kind, source, target?, displayName?, requestId}` performs install, enable and Bot binding as stages. Retry the same requestId if queued; follow `operation`/`deployments` until the device receipt reports the applied version.

Update/rollback: `update {installationId, targetVersion, source?, requestId}` moves to a newer version; `rollback` returns to a prior one — both are operations, both need deployment receipts before you report the change as live.

Per-Bot switches (enabled flag, config overrides) belong to `set_bot_capability` — see references/bots.md. This tool manages the package and binding lifecycle.
