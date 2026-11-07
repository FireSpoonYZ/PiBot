# Managed skills — manage_bot_skill

`manage_bot_skill({deviceId, botId, action, ...})` operates on the CENTER-managed skill service for exactly the target Bot. Drafts are revisioned files; publishing installs a normal skill package and binds it to that Bot only. There is no direct SKILL filesystem — always go through this tool.

Actions: `list | read | create | update | delete | archive | restore | pin | lock | history | rollback | publish | adopt | snapshots | restore_snapshot`.

Common fields: `skillId?`, `name?`, `category?`, `skillName?`, `newName?`, `description?`, `files?` (relative path → UTF-8 content or null to delete on update), `path?`, `content?` (null deletes), `expectedRevision?`, `requestId?`, `pinned?`, `locked?`, `revision?`, `installationId?`. The tool's own schema is authoritative for which fields each action requires.

## Rules

- Mutations other than `restore_snapshot` require `expectedRevision` — the revision returned by your last `read`/`list`/`history` (`create` uses `expectedRevision: null`). A conflict means re-read and retry.
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

## Snapshot recovery

1. `snapshots` lists the latest 20 retained snapshots, or use `snapshots {snapshotId}` for one. Each reply includes `expectedRevisions`, keyed by skill name (content revision, state revision, identity; null for a missing skill).
2. `restore_snapshot {snapshotId, expectedRevisions, requestId}` atomically copies every managed snapshot skill into a **new draft revision**. Concurrent changes conflict; repeat the same requestId for the same receipt. Existing revision history, live usage counts and protection flags survive. Permanently deleted skills are recreated with new identities; already deleted history cannot be reconstructed.
3. This is additive recovery, not a destructive library reset: skills created after the snapshot remain. Current lifecycle state, installed packages and bindings are not changed. Archived skills must first use the existing `restore` action, then `publish`; each skill reply includes `requiresRestore`, `nextActions`, current `publishedRevision` and deployment plans/receipts. `restoreMode: 'drafts'` is not an online rollback. The receipt explicitly says publication/deployment `not_requested`; use `publish` per restored active skill, then inspect deployment before claiming it is live. Any previously queued package deployment is not rolled back.
4. Snapshots come from curator consolidation runs; ordinary curator retention keeps the newest two. A snapshot already pruned is unavailable.

## Actual use and scheduled dependencies

Successful `read` calls on an enabled, bound skill's SKILL.md or nonempty files under references/scripts/templates/assets count as use (including nested read calls). Merely listing/rendering the skill directory is not use. Host observations use stable call identities and a Host-authenticated idempotent Center endpoint. Reporting failures never fail the read; disconnected/expired observations may be lost, not fabricated.

For `schedule_task`, declare dependencies explicitly with `skills: ["skill-name"]` (default `[]`, at most 100 unique names). Paused tasks still protect these names during curation. Execution instructs the Bot to load them first. Free-text prompts are never parsed for dependencies. Curator consolidation rewrites these structured names transactionally and bumps only changed task revisions; already-created occurrences keep their original input.
