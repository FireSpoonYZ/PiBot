# Bot identity, profile, SOUL, model, capabilities, lifecycle

All tools take `deviceId` + `botId` for the TARGET Bot — which may be another device or another Bot, never assumed from context.

## Finding targets

`list_bots({offset?, limit?})` pages the device+Bot directory. Entries are `{type:'device'|'bot'|'error'}`; Bot entries carry `botId, name, description, isPrimary, archivedAt, deviceId, deviceName, platform, online`. Follow `nextOffset` until null; per-device errors appear as error entries, not silent gaps.

`get_bot({deviceId, botId})` returns full metadata, workspace `cwd`, primary/archive status, last activity.

## Create and profile

- `create_bot({deviceId, name, description, modelRef?, cwd?})` — omit `cwd` for the device default workspace. The receipt only registers the Bot; it does not start a task.
- `update_bot_profile({deviceId, botId, name?, description?})` — display name (role) and/or responsibility description.

## SOUL

- `get_bot_soul({deviceId, botId})` → SOUL.md text + current revision.
- `set_bot_soul({deviceId, botId, text, expectedRevision?})` — CAS; omitting `expectedRevision` auto-reads the current revision. The target Bot must be idle; a busy Bot returns the busy error with the original text untouched. When the target IS the calling Bot, the change is queued to the next safe idle boundary and the reply reports that queued/applied status — never claim an immediate rewrite.

## Model selection

- `get_bot_model({deviceId, botId})` → Center-managed `modelRef` (provider/modelId), `thinkingLevel`, and the available catalog.
- `set_bot_model({deviceId, botId, modelRef?, thinkingLevel?, codemode?, codemodeOnly?, expectedRevision?})` — `thinkingLevel` is one of `off|minimal|low|medium|high|xhigh|max`; `null` clears an override. CAS via `expectedRevision`.

## Capabilities

- `get_bot_capabilities({deviceId, botId})` → Center-managed capabilities (plugins, skills, MCP servers) with per-Bot `enabled`, `overrides`, `revision`.
- `set_bot_capability({deviceId, botId, installationId, enabled?, overrides?, expectedRevision?})` — enable/disable or set per-Bot config overrides for one installation. Package-level install/update is `manage_bot_installation` (see references/installations.md); this tool only changes the Bot's binding/config.

## Interrupt and lifecycle

All require the target Bot idle and non-archived where noted; all except `unarchive_bot` refuse self-targeting.

| Tool | Effect |
| --- | --- |
| `abort_bot` | Abort the active generation task in the target Bot's primary conversation |
| `clear_bot_history` | Reset an idle Bot's primary conversation context |
| `compact_bot` | Manually compact an idle Bot's primary conversation context |
| `archive_bot` | Make an idle non-primary Bot read-only |
| `unarchive_bot` | Restore an archived Bot so it accepts tasks again |
| `delete_bot` | Permanently delete an idle non-primary Bot |

A 409/busy-style error means the Bot is mid-turn; do not retry destructively — report it and ask how to proceed.
