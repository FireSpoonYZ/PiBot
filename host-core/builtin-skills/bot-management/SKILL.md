---
name: bot-management
description: Manage e-launcher Bots across devices — identity, profile, SOUL, model, capabilities, Bot-owned managed skills (draft/publish/adopt), Bot learning jobs, and capability package installations. Load when a request creates, configures, reviews, teaches, or operates on a Bot rather than doing the Bot's own task.
---

# Bot management

Operate on Bots through the management tools — never by editing their files, databases, or runtime state directly. Load the matching file under `references/` (resolve paths against this skill's directory) before acting.

## Hard rules

- Every management tool takes explicit `deviceId` + `botId`. Resolve them with `list_bots` first; never guess a target or let one Bot's fields bleed into another.
- Mutations are compare-and-swap: read first and pass the returned revision as `expectedRevision`. A revision conflict means re-read and retry — never force or silently retry with a stale value. `set_bot_soul` is the one exception: it reads the current revision itself when `expectedRevision` is omitted.
- Receipts are honest states, not wishes: `saved`/`applied` means done; `queued`, `waiting-idle`, `enabling`, or a running learning job means accepted but NOT live; `failed` is terminal for that operation. Never describe a queued deploy or a started job as a finished change.
- A receipt does not start a task; an accepted install does not mean a Bot is enabled; a device deployment receipt is what confirms the device-applied version.
- A Bot cannot abort, clear history, compact, archive, or delete itself. Editing its own SOUL or other idle-gated fields does not mutate mid-turn — it queues to the next safe idle boundary and reports that status.
- Learning never rewrites SOUL; SOUL stays user-requested management only.

## Load a reference when the task matches

| File | Load when |
| --- | --- |
| `references/bots.md` | Create, inspect, configure (profile/SOUL/model/capabilities), interrupt, archive, or delete a Bot |
| `references/skills.md` | Read, draft, revise, pin/lock, publish, or adopt a Bot's managed skill — `manage_bot_skill` |
| `references/learning.md` | Check, configure, start, follow, or cancel Bot learning jobs — `manage_bot_learning` |
| `references/installations.md` | Inspect, install, update, roll back, enable, or remove capability packages — `manage_bot_installation` |
