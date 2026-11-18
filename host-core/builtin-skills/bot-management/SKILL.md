---
name: bot-management
description: Manage e-launcher Bots across devices — create, save, or update the current Bot's own managed skills when asked to build/capture/edit a skill, or manage any Bot's identity, profile, SOUL, model, capabilities, managed skills, learning jobs, and capability package installations. Load when a request creates, configures, reviews, teaches, or operates on a Bot or its managed skills rather than doing an unrelated task.
---

# Bot management

Operate on Bots and managed skills through the management tools — never by editing their files, databases, or runtime state directly. Load the matching file under `references/` (resolve paths against this skill's directory) before acting.

## Hard rules

- `manage_bot_skill` may omit `deviceId`/`botId` to target the current Bot's own skills, or pass both to manage another Bot. All other management tools take explicit `deviceId` + `botId` (resolve via `list_bots` first; never guess a target or let one Bot's fields bleed into another).
- `manage_bot_skill` saves and activates in one step (`create`/`update`/`patch`/`adopt`) without `expectedRevision` or a separate `publish` call. Other CAS mutations (`set_bot_model`, `set_bot_capability`, `manage_bot_learning` `configure`) read first and pass `expectedRevision` (`set_bot_soul` auto-reads when `expectedRevision` is omitted). A revision conflict means re-read and retry — never force or silently retry with a stale value.
- Receipts are honest states, not wishes: `saved`/`applied` means done; `queued`, `waiting-idle`, `enabling`, or a running learning job means accepted but NOT live; `failed` is terminal for that operation. Never describe a queued deploy or a started job as a finished change.
- A receipt does not start a task; an accepted install does not mean a Bot is enabled; a device deployment receipt is what confirms the device-applied version.
- A Bot cannot abort, clear history, compact, archive, or delete itself. Editing its own SOUL or other idle-gated fields does not mutate mid-turn — it queues to the next safe idle boundary and reports that status.
- Learning never rewrites SOUL; SOUL stays user-requested management only.

## Load a reference when the task matches

| File | Load when |
| --- | --- |
| `references/bots.md` | Create, inspect, configure (profile/SOUL/model/capabilities), interrupt, archive, or delete a Bot |
| `references/skills.md` | Read, create, update, patch, pin/lock, archive/restore, delete, or adopt a Bot's managed skill — `manage_bot_skill` |
| `references/learning.md` | Check, configure, start, follow, or cancel Bot learning jobs — `manage_bot_learning` |
| `references/installations.md` | Inspect, install, update, enable, or remove capability packages — `manage_bot_installation` |
