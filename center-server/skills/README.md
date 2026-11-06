# center-server/skills — per-Bot managed skill service

```js
const skills = await openSkillManager({ dataRoot, store, packages, notify });
// notify(deviceId) — same SSE push the capability route uses (reconcile+notify pair).
```

Own SQLite: `dataRoot/skills/skills.sqlite` — `skills` (draft rows, CAS `revision`),
`skill_revisions` (immutable content snapshots, `files` = map relative path → UTF-8),
`skill_usage` (upstream .usage.json records keyed by name + `revision` CAS),
`skill_requests` (execute() requestId → stored result, idempotent replay).

No secret storage; file paths confined to `SKILL.md` + `references|templates|scripts|assets/**`;
limits mirror upstream (100k chars SKILL.md, 1 MiB/file, +128 files, 4 MiB total).

## execute(identity, input)

`identity = {deviceId, botId, origin?:'foreground'|'background_review'|'curator', sessionId?, requestId?}`.
Bot must be registered. Mutations serialize per (device,bot); `expectedRevision` is required:
- `create`, `adopt` → `expectedRevision: null`
- `update`, `delete`, `rollback`, `publish` → current `revision` (content CAS)
- `archive`, `restore`, `pin`, `lock` → current `stateRevision` (usage-record CAS)
- `restore_snapshot` → `snapshotId`, `expectedRevisions` map from `snapshots`, mandatory `requestId`; atomic drafts + idempotent receipt

Actions: `list | read | create | update | delete | archive | restore | pin | lock | history | rollback | publish | adopt | snapshots | restore_snapshot`.

| action | fields | notes |
|---|---|---|
| list | — | `{skills:[managed summaries], installed:[bound skill packages]}` |
| read | skillId\|name\|installationId, path? | managed → `files` map or single `content`; installed → same + `source:'installed'` |
| create | name, files? \| content, description?, category? | files must include valid SKILL.md |
| update | skillId\|name, files? (upsert; `null` deletes), path+content (null removes), description? | rewrites frontmatter description scalar; block scalars refused |
| delete | skillId\|name | hard delete; published → `packages.uninstall` first (returns operationId, phase 'queued') |
| archive / restore | skillId\|name | usage `state`; published → Bot binding disabled / restored (was-enabled only) |
| pin / lock | skillId\|name, pinned\|locked | pin = managed only; lock = any resolvable name incl. installed |
| snapshots | snapshotId? | latest 20 retained snapshots, or selected snapshot; current per-name CAS tokens, not file contents |
| restore_snapshot | snapshotId, expectedRevisions, requestId | additive recovery; new draft revisions; preserves current lifecycle/bindings/deployments; preserves counters/protection flags and post-snapshot skills; no publication/deployment requested |
| history | skillId\|name | all content revisions |
| rollback | skillId\|name, revision | copies rev → new head (origin 'rollback') |
| publish | skillId\|name | builds tar (`package/` root: package.json `bot-skill-<skillId>` @ `1.0.<headRev>` + files) → uploadArtifact → install (or update) → enable → `putBotCapability(enabled)` → `packages.reconcileDevice` + `notify(deviceId)`; awaits ≤8s metadata readiness (`activation.status==='enabled'`), never device deploy. Result `publication.status` ∈ 'enabled'\|'activating'\|'queued'\|'failed' — pending is NOT request-pinned so retries resume. |
| adopt | installationId \| name, newName? | copies installed skill → managed draft (source 'adopted', created_by 'agent') |

Results: skill summaries carry `skillId, name, path, description, revision, stateRevision,
headRevision, state, pinned, locked, createdBy, source, installationId?, publishedRevision?,
createdAt, updatedAt`. Errors use the standard center codes (INVALID_ARGUMENT, NOT_FOUND,
REVISION_CONFLICT, REQUEST_CONFLICT, INVALID_STATE, FORBIDDEN, PAYLOAD_TOO_LARGE).

## hermes(identity, name, args)

Upstream adapter — answers both Python `skill.call` callbacks and the learning
internal `action:'tool'` path (identity.origin = review mode, sessionId = jobId).

Tool names → JSON **string** (upstream tools return `json.dumps`):
- `skills_list` → `{success, skills:[live managed], installed:[bound], archived:[names], count}`
- `skill_view {name, file_path?}` → `{success, name, path, content|files, description, source, ...}`
- `skill_manage {operations:[…]}` (advertised atomic batch) or legacy flat
  `{action, name, content?, category?, file_path?, file_content?, old_string?, new_string?, replace_all?, absorbed_into?}`;
  actions create/edit/patch/delete/write_file/remove_file.
  Success shapes keep `success:true` + `message` + `_change` (+ `_archived` on review deletes);
  batch returns `{success, results:[{action,name,file_path?,success,message?}], operations_applied}`,
  failures `{success:false, error, results, rolled_back:true}`. Errors never carry `_change`.
- `read_file {path, offset?, limit?}`, `search_files {query, path?, case_sensitive?, max_results?}`
  — ADAPTED to the Bot's skill library (upstream file_tools.py is not vendored); both
  register read-before-write marks like upstream.

`skill_usage.<fn>` / `skill_provenance.<fn>` → plain JSON values (kwargs object;
`skill_name` or `name` accepted; tuples → arrays, e.g. archive_skill → `[ok,msg]`):
bump_view, bump_use, bump_patch, record_created, record_installed, mark_agent_created,
forget, get_record, load_usage, save_usage, seed_record_if_missing, reanchor_clock,
set_state, set_pinned, set_locked, is_locked, locked_skill_names,
is_agent_created, is_bundled(false), is_hub_installed(bound-installed claim),
is_external_only(false), is_protected_builtin(false), is_curation_eligible,
is_curator_managed, provenance, telemetry_provenance, list_agent_created_skill_names,
list_archived_skill_names, list_unmanaged_skill_names, unmanaged_report, curated_report,
usage_report, read_suppressed_names([]), archive_skill, restore_skill, adopt_skill,
latest_activity_at, activity_count, read_skill_name({content,fallback}), constants.
skill_provenance: is_background_review, is_unattended_review, get_current_write_origin,
set/reset_current_write_origin (no-op nulls). Unknown names throw INVALID_ARGUMENT.
`skill_file_lock` is intentionally NOT mapped — mutations serialize center-side; C must no-op it.

Upstream protections implemented adapter-side: read-before-write marks (per
device+bot+sessionScope; autonomous origins only), locked (autonomous writes refused),
pinned (delete refused), pinned/locked semantics live in usage records exactly like
upstream. Autonomous delete → recoverable archive + binding disable (never hard delete).

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
  absorbed_into absorb-target resolves managed skills only.
- Dependencies: `tar` via the installed dependency tree; `yaml` resolves through
  `host-core/package.json` and is used for skill frontmatter and curator summaries.

## Integration

Hermes skill writes commit revisions atomically before publication. Publication
receipts identify queued, activating, enabled or failed state; enabled is not a
Host deployment receipt. Failed or pending publication keeps the draft for retry.
Curator snapshots retain managed content and metadata in the center database;
whole snapshots can be recovered into new drafts through snapshots/restore_snapshot; individual content revisions remain recoverable through history/rollback. A hard-deleted skill is recreated with a new identity (deleted history is not recoverable). Publication retry timers are revision-fenced so a previous pending publication cannot automatically publish restored drafts. Existing deployment operations/bindings are not rolled back.

Foreground `skill_manage` edits locked/pinned skills freely (upstream parity: the
lock is an autonomous-pass guard); execute() delete ignores pinned, adapter refuses.

## Host usage observations

`POST /api/host/devices/:deviceId/bots/:botId/skills/usage` is Host-only, requires the authenticated device to match, and calls `reportUse(identity,input)`. Fields: `requestId` (SHA-256 of stable Host/Bot/installation/version/conversation/task/call identity), `installationId, version, skillName, skillPath, path`. Center validates the enabled Bot binding, active skill installation/version, package skill directory and actual member file, then atomically bumps existing skill_usage and records the idempotent receipt in skill_requests. Managed installation IDs resolve back to managed directory names, even when frontmatter names differ. No telemetry action is advertised to the model.

## Curator schedule bridge

`cron.jobs.referenced_skill_names()` -> `schedule.call {name:"referenced_skill_names",args:{}}`, list converted to Python set.
`cron.jobs.rewrite_skill_refs(*, consolidated=None, pruned=None)` -> `schedule.call {name:"rewrite_skill_refs",args:{consolidated,pruned}}`.

Lane B authorizes/dispatches these calls for the current curator job Bot to `schedules.hermesSkillCall(bot,name,args,{signal}={})`. The reply is `{rewrites:[{job_id,job_name,before,after,mapped,dropped}],jobs_updated,jobs_scanned}`. Node and Android engines include disabled jobs, operate in one storage transaction, preserve due times and already-claimed runs, bump changed revisions, and re-plan alarms. Other names error. No snapshot-derived or prompt-regex dependencies.

The optional fourth argument carries the learning job's abort signal; existing three-argument callers remain compatible. Node checks cancellation before its synchronous transaction. Android forwards the signal through the existing native bridge options, reusing queued/beforeWrite cancellation and native_cancel for the native executor queue. Cancellation does not roll back an already committed transaction or change the bridge's existing outcome semantics.
