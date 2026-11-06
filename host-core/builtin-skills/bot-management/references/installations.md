# Capability installations — manage_bot_installation

`manage_bot_installation({deviceId, botId, action, ...})` uses existing Center-managed packages (plugins, skills, MCP servers), not a new marketplace.

Actions: `catalog | describe | check | probe | inspect | install | update | rollback | enable | disable | uninstall | operation | deployments`.

## Discover and configure safely

1. `catalog {}`: minimal installation metadata (IDs, name, kind, target, intended version and global enabled intent). No package sources, configuration values, credentials or other Bots' bindings.
2. `describe {installationId}`: configuration schema and declared action schemas, probe availability and setup guidance. Credential slots include path, reference ID, configured flag and revision **only** for an installation bound to/owned by the target Bot; otherwise credentialRefs is null. No secret resolution or configuration values.
3. Use the existing **Center Credentials / capability configuration UI** to enter secrets and select `credential-ref` values. Never ask for API keys/passwords in chat, questionnaires, learning materials or tool arguments. Per-Bot switches and overrides use `set_bot_capability` (references/bots.md); global/shared configuration is owner territory.
4. `check {installationId}`: requires the target's actual binding, including a shared installation. Returns schema/credential presence separately from deployed status, global/binding revisions, desired runtime revision, the target Bot's applied configuration receipt and package deployment receipt/version. No provider network call. `configured` means schema valid and referenced credentials present, **not** valid credentials or connectivity; optional unset credential slots alone do not make a schema invalid. Provider-specific readiness is established during plugin activation and explicit probe.
5. `probe {installationId}`: only explicit calls perform a real read-only provider request, potentially billed. Requires enabled binding/global activation, current package and Bot configuration receipts. Rechecks desired revision/plan/applied plugin version afterward. Reports `blocked | failed | stale | verified`; never labels a static enabled flag as verified. Probe receipts are returned for this call, not persisted health history. A later check reports `not-run`, not cached success.

Shared installations can be described/checked/probed for this Bot; a single Bot still cannot update, disable, uninstall or otherwise rewrite shared global state. Legacy inspect/deployments/operation keep their existing shared-scope restrictions. Missing bindings or older plugin versions must be configured/upgraded through Center first.

### Explicit probe boundaries

- Webfox: one search for `example.com` with maxResults=1 if search is configured, otherwise one contents extraction of `https://example.com/`. No retries; 10-second deadline. Only that selected capability/provider is verified, not every provider, answer or research.
- Hindsight: one authenticated bank-list read filtered to the Bot's primary bank, limit=1; never creates a bank or writes memory. Empty list is a successful connection/read, not proof that memory exists or writes work.
- Provider bodies and raw error strings are not returned. Plugin action input/output schemas, current authorization and action cancellation still apply.
- Across Center HTTP/relay, cancelling the HTTP wait does not cancel an already-dispatched Host request; the probe's 10-second signal bounds that request. Local learning action cancellation is separate and can propagate through the Host plugin action signal.
- Configuration comparison conservatively uses the device runtime revision plus this Bot's receipt; unrelated device changes may temporarily report stale until a fresh receipt. A plan or saved binding is never an applied deployment.

## Existing lifecycle flows

- Mutations carry requestId/operation IDs: same request → same operationId; conflicting content → conflict error.
- Install: `install {kind, source, target?, displayName?, requestId}` performs install, global enable and Bot binding in stages. `bound` means saved binding, not applied deployment. Retry the same requestId if queued.
- Poll `operation {operationId}` and `deployments {installationId}` for allowed nonshared installations. Only matching applied/removed version/revision receipts prove completion. `waiting-idle` means deferred; `failed` is terminal for that operation.
- Update: `update {installationId, targetVersion, source?, requestId}`; rollback returns to a prior version. Both require receipts before reporting live success.
- `disable` / `uninstall` preserve terminal phases and do not re-enter validation.

## Learning bridge actions (not installation tool actions)

- Hindsight `learningMemoryStatus({})` returns `{enabled:true,canRead:true,canWrite:mode==='read-write',mode}` only through the same active/authorized policy as memory actions. It performs no network request or write and is not connectivity verification. Disabled/missing/ambiguous providers remain errors for the caller to handle.
- Webfox `readLearningSource({url})` uses **only** the configured contents provider. HTTP(S), no URL credentials/whitespace, max 2048 characters, one source per call; missing provider/access/extraction errors are explicit. The learning caller must enforce its declared-source allowlist. The action preserves the requested URL and renders extracted material with the existing Webfox renderer, bounded to 48 KiB UTF-8 with optional `truncated:true`; no spill files or commands. The action signal and a 30-second ceiling bound extraction (a shorter configured timeout still applies).
- These APIs require updated packages: Webfox 1.1.0, Hindsight 1.2.0. Updating source code alone does not deploy plugin payloads.
