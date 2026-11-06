# Managed skills — manage_bot_skill

`manage_bot_skill({deviceId, botId, action, ...})` operates on the CENTER-managed skill service for exactly the target Bot. Drafts are revisioned files; publishing installs a normal skill package and binds it to that Bot only. There is no direct SKILL filesystem — always go through this tool.

Actions: `list | read | create | update | delete | archive | restore | pin | lock | history | rollback | publish | adopt`.

Common fields: `skillId?`, `name?`, `category?`, `skillName?`, `newName?`, `description?`, `files?` (relative path → UTF-8 content or null to delete on update), `path?`, `content?` (null deletes), `expectedRevision?`, `requestId?`, `pinned?`, `locked?`, `revision?`, `installationId?`. The tool's own schema is authoritative for which fields each action requires.

## Rules

- Every mutation requires `expectedRevision` — the revision returned by your last `read`/`list`/`history` (`create` uses `expectedRevision: null`). A conflict means re-read and retry.
- Pass `requestId` on mutations so retries stay idempotent instead of double-writing.
- Paths are relative and confined to the skill; no secrets in skill files; file count and bytes are bounded by the service.
- `locked` skills refuse writes — including background-review writes. `pinned` skills are protected from automatic archive. Respect both flags before editing.
- Replies distinguish `saved`, `queued`/`waiting-idle`, `applied`, `failed` — report exactly what came back.

## Flows

Draft a new skill:
1. `manage_bot_skill list` — check the name is not already taken.
2. `manage_bot_skill create` with `{name, description, files: {'SKILL.md': '...'}, expectedRevision: null, requestId}`.
3. Iterate with `read` → `update` (files map) carrying the current `expectedRevision`.

Revise an existing managed skill:
1. `read` (full `files` or `path`/`content`) → `update` with the returned revision → `history` to confirm the new revision.
2. `rollback {revision}` restores an earlier revision as a new revision; `history` lists revisions.

Publish (make it live for the Bot):
1. `publish {skillId, expectedRevision, requestId}` packages the draft, uploads the artifact, installs/updates the package, enables it, and binds ONLY the target Bot.
2. The reply carries `installationId` and a publication receipt. `queued`/`activating` means publication is pending; `enabled` means bound but does not prove Host deployment — verify with `manage_bot_installation operation/deployments` before declaring it live. A failed publish keeps the draft; retry idempotently with the same `requestId`.

Edit a shared/installed skill you do not own:
- Do NOT mutate shared package contents in place. `adopt` copies the installed skill into a Bot-owned managed draft, then edit and publish as above. Read-only inspection of installed skills stays a plain `read`.

Lifecycle:
- `archive`/`restore` move a managed skill out of / back into the active set; `delete` is permanent. `pin {pinned}` and `lock {locked}` update protection flags with CAS.
