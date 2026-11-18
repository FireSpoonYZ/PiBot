# center-server/skills — per-Bot managed skill service

```js
const skills = await openSkillManager({ dataRoot, store, packages, notify });
// notify(deviceId) — same SSE push the capability route uses (reconcile+notify pair).
```

Own SQLite: `dataRoot/skills/skills.sqlite` — `skills` (single-state rows with `files` JSON map,
`learning_source` JSON metadata, and CAS `revision`),
`skill_usage` (upstream .usage.json records keyed by name + `revision` CAS),
`skill_requests` (execute() requestId → stored result, idempotent replay).

No secret storage; file paths confined to `SKILL.md` + `references|templates|scripts|assets/**`;
limits mirror upstream (100k chars SKILL.md, 1 MiB/file, +128 files, 4 MiB total).

## execute(identity, input)

`identity = {deviceId, botId, origin?:'foreground'|'background_review'|'curator', sessionId?, requestId?}`.
Bot must be registered. Mutations serialize per (device,bot); `expectedRevision` is not required.

Actions: `list | read | create | update | patch | delete | archive | restore | pin | lock | adopt`.

| action | fields | notes |
|---|---|---|
| list | — | `{skills:[managed summaries], installed:[bound skill packages]}` |
| read | skillId\|name\|installationId, path? | managed → `files` map or single `content`; installed → same + `source:'installed'` |
| create | name, files? \| content, description?, category? | files must include valid SKILL.md; auto-syncs to `packages` |
| update | skillId\|name, files? (upsert; `null` deletes), path+content (null removes), description? | rewrites frontmatter description scalar; block scalars refused; auto-syncs to `packages` |
| patch | skillId\|name, path? (`SKILL.md`), oldText\|old_string, newText\|new_string, replaceAll\|replace_all? | single/all exact match replacement on a skill file; validates SKILL.md & limits; auto-syncs to `packages` |
| delete | skillId\|name | hard delete; synced skill → `packages.uninstall` first (returns operationId, phase 'queued') |
| archive / restore | skillId\|name | usage `state`; active skill → Bot binding disabled / restored and synced |
| pin / lock | skillId\|name, pinned\|locked | pin = managed only; lock = any resolvable name incl. installed |
| adopt | installationId \| name, newName? | copies installed skill → managed skill (source 'adopted', created_by 'agent') and syncs package |

Writes (`create`, `update`, `patch`, `adopt`, `restore`, `skill_manage`) immediately build a tar
(`package/` root: package.json `bot-skill-<skillId>` @ `0.0.0-h<sha256(json).slice(0,12)>` + files),
uploadArtifact, install (with `autoEnable: true`) or update (with `allowSourceSwitch: true`), enable
`putBotCapability`, and call `packages.reconcileDevice` + `notify(deviceId)` across affected devices.

Results: skill summaries carry `skillId, name, path, description, revision, stateRevision,
state, pinned, locked, createdBy, source, installationId?, createdAt, updatedAt`. Errors use the
standard center codes (INVALID_ARGUMENT, NOT_FOUND, REVISION_CONFLICT, REQUEST_CONFLICT,
INVALID_STATE, FORBIDDEN, PAYLOAD_TOO_LARGE).

## review(identity, input)

The client learned-skills panel uses the dedicated Bot-scoped `skill-reviews` endpoint.
The device and Bot come from the authenticated route or Host call.

| action | fields | result |
|---|---|---|
| list | `includeArchived?` | `{items}` with all managed skills of the Bot (`active`, `stale`, and optionally `archived`), revision/state tokens, visibility scope, and deployment status |
| read | `skillId`, `path?` | Managed skill summary and `files` map (plus `file: {path, content}` when `path` is given) |
| pin / lock | `skillId`, `pinned`\|`locked`, `expectedRevision?`, `requestId` | Updates protection flags |
| archive / restore | `skillId`, `expectedRevision?`, `requestId` | Archives (disabling Bot binding) or restores (re-enabling Bot binding) the skill |

## learningTool(identity, name, args)

The learning adapter handles Python `skill.call` callbacks and the internal
`action:'tool'` path. The caller supplies the job ID, write origin and available
source metadata. A batch request ID is scoped to the job.

- `skills_list` lists managed skills and bound shared/external Skill packages.
- `skill_view`, `read_file` and `search_files` read the Bot's Skill library and
  record which files were viewed during the job.
- `skill_manage` accepts an atomic `operations` array, or a single operation
  using flat arguments. Supported operations are `create`, `edit`, `patch`,
  `write_file`, `remove_file`, and (for `curator` consolidation) `delete` with
  `absorbed_into` (which archives the absorbed skill rather than destroying history).
  Every successful write updates the skill in place and auto-syncs to the owner Bot
  (`visibilityScope: 'private'` by default, `reviewRequired: false`). A failed
  operation rolls back the batch.

## Installation Skill Files & Inline Install

`openSkillManager` also exposes three center-level helpers used by `/api/installations`:
- `prepareInlineSkill({ name, files, content, description })` (`POST /api/installations` with `kind: 'skill'`, `source.type: 'inline'`): validates files, packages tar (`0.0.0-h<hash12>`), and stores an artifact returning `{ name, version, artifactRef }`.
- `readInstallationFiles(installationId)` (`GET /api/installations/:id/skill-files`): reads the file map from the current installation artifact (or linked managed skill).
- `writeInstallationFiles(installationId, { files })` (`PUT /api/installations/:id/skill-files`): validates and updates the installation's files/artifact (syncing linked managed skill when present) and pushes an update across bound devices.

## Integration

Learning updates managed skill files atomically and auto-syncs active skills via the
artifact installation, activation and deployment pipeline.

Tool results are JSON strings with the usual `success`, `_change` and batch
result fields. The internal `skill_usage.*` and `skill_provenance.*` callbacks
use plain JSON values (`mark_stale`, `mark_active`, `archive_skill`, `curated_report`).
Shared skills (`visibilityScope` of `'assigned'` or `'global'`, or bound to multiple
Bots) report `pinned: true` in `curated_report` and refuse single-Bot auto-archival
and curator consolidation deletes.

## Ownership, Visibility Scopes & Usage Rollup

- Managed skills install with `ownerBot: { deviceId, botId, skillId, skillName }` and
  default `visibilityScope: 'private'`.
- Center owners can switch `visibilityScope` via `PATCH /api/installations/:id` between
  `'private'` (owner Bot only), `'assigned'` (explicit per-Bot bindings), and `'global'`
  (auto-enabled for all existing `revision === 0` Bots and newly created Bots).
- `POST /api/host/devices/:deviceId/bots/:botId/skills/usage` (`reportUse`) resolves
  `bot-skill-<skillId>` back to `installation.ownerBot` when invoked by another Bot,
  crediting cross-Bot usage to the owner skill's `skill_usage` record.

## Exact vs adapted (flag for integrators)

- EXACT: validation limits/regexes, frontmatter rules, file_path confinement, usage
  record shape + transitions, curated/usage reports, result envelopes, lock/pin guards,
  batch atomicity (single SQLite tx), requestId idempotency.
- ADAPTED: patch matching is EXACT-substring (upstream fuzzy_find_and_replace not
  vendored — a strict subset; no fuzzy hints); skills_list/skill_view/read_file/
  search_files result shapes (tools not vendored — fields chosen to be self-describing);
  installed packages map to upstream "hub/external" (provenance 'hub'/'installed',
  read-only); SKILL_PROMPT_DESC_LIMIT=60 (agent/curator.py, learn_prompt.py);
  linter findings + security scan omitted (opt-in upstream, not vendored);
- Dependencies: `tar` via the installed dependency tree; `yaml` resolves through
  `host-core/package.json` and is used for skill frontmatter and curator summaries.

## Host usage observations

`POST /api/host/devices/:deviceId/bots/:botId/skills/usage` is Host-only, requires the authenticated device to match, and calls `reportUse(identity,input)`. Fields: `requestId` (SHA-256 of stable Host/Bot/installation/version/conversation/task/call identity), `installationId, version, skillName, skillPath, path`. Center validates the enabled Bot binding, active skill installation/version, package skill directory and actual member file, then atomically bumps existing skill_usage and records the idempotent receipt in skill_requests. Managed installation IDs resolve back to `installation.ownerBot` and managed directory names, even when frontmatter names differ. No telemetry action is advertised to the model.

## Curator schedule references

`cron.jobs.referenced_skill_names()` reads the Bot's scheduled Skill references
through the Host callback. Scheduled skills are protected from single-Bot archival;
when consolidation absorbs a scheduled skill into a target skill, schedule
references can be updated transactionally.
