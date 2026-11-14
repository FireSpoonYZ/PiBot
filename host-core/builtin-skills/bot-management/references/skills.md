# Managed skills — manage_bot_skill

`manage_bot_skill({deviceId?, botId?, action, ...})` operates on the Center-managed skill service. Omit `deviceId` and `botId` to manage the current Bot's own skills, or pass both to manage a target Bot's skills. There is no direct SKILL filesystem — always go through this tool.

Actions: `list | read | create | update | patch | delete | archive | restore | pin | lock | adopt`.

Common fields: `skillId?`, `name?`, `category?`, `skillName?`, `newName?`, `description?`, `files?` (relative path → UTF-8 content or `null` to delete on `update`), `path?`, `content?` (`null` deletes an extra file on `update`), `oldText?`, `newText?`, `replaceAll?`, `requestId?`, `pinned?`, `locked?`, `installationId?`. The tool's own schema is authoritative for which fields each action requires.

## Rules

- One-step save & activate: `create`, `update`, `patch`, and `adopt` save and take effect immediately in a single call — no separate publish step and no `expectedRevision` required.
- Pass `requestId` on mutations so retries stay idempotent instead of double-writing.
- Paths are relative (`SKILL.md`, `references/`, `scripts/`, `templates/`, `assets/`) and confined to the skill; no secrets in skill files; file count and bytes are bounded by the service.
- `locked` skills refuse writes — including background-review writes. `pinned` skills are protected from automatic archive. Respect both flags before editing.
- External or shared skills from others are read-only; use `adopt` to copy one into an owned skill before editing.

## Flows

Create a new skill:
1. `manage_bot_skill {action: 'list'}` — check the name is not already taken.
2. `manage_bot_skill {action: 'create', name, description, ...}` using one of:
   - `content` (full `SKILL.md` content)
   - `files: {'SKILL.md': '...', 'references/guide.md': '...'}`
   - `path` + `content`

Update or patch an existing skill:
- `read {skillId}` to inspect the current `SKILL.md` or a specific `path`.
- `update {skillId, content | files | path+content}` to replace content (`files` with `null` deletes an extra file).
- `patch {skillId, path?, oldText, newText, replaceAll?}` to replace `oldText` with `newText` in `path` (defaults to `'SKILL.md'`).

Edit an external or shared skill you do not own:
- Do NOT mutate shared skills in place. `read` to inspect, `adopt` to copy into an owned skill, then `update` or `patch`.

Lifecycle:
- `archive` / `restore` move a managed skill out of / back into the active set; `delete` is permanent.
- `pin {skillId, pinned}` and `lock {skillId, locked}` update protection flags.

## Actual use and scheduled dependencies

Successful `read` calls on an enabled, bound skill's `SKILL.md` or nonempty files under `references/scripts/templates/assets` count as use (including nested read calls). Merely listing/rendering the skill directory is not use. Host observations use stable call identities and a Host-authenticated idempotent Center endpoint. Reporting failures never fail the read; disconnected/expired observations may be lost, not fabricated.

For `schedule_task`, declare dependencies explicitly with `skills: ["skill-name"]` (default `[]`, at most 100 unique names). Paused tasks still protect these names during curation. Execution instructs the Bot to load them first. Free-text prompts are never parsed for dependencies. Curator consolidation rewrites these structured names transactionally and bumps only changed task revisions; already-created occurrences keep their original input.
