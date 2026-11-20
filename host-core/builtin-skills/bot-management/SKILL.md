---
name: bot-management
description: Manage e-launcher Bots across devices — create, save, or update the current Bot's own managed skills when asked to build/capture/edit a skill, or manage any Bot's identity, profile, SOUL, model, capabilities, managed skills, learning jobs, and capability package installations. Load when a request creates, configures, reviews, teaches, or operates on a Bot or its managed skills rather than doing an unrelated task.
---

# Bot management

Operate on Bots and managed skills through the management tools — never by editing their files, databases, or runtime state directly. Prefer the narrow deferred operation tools via `tool_search`:

- Bots & lifecycle: `pibot_bots_list`, `pibot_bot_get`, `pibot_bot_create`, `pibot_bot_update_profile`, `pibot_bot_soul_get`, `pibot_bot_set_soul`, `pibot_bot_set_model`, `pibot_bot_set_cwd`, `pibot_bot_set_avatar`, `pibot_bot_set_primary`, `pibot_bot_session_control`, `pibot_bot_archive`, `pibot_bot_unarchive`, `pibot_bot_delete`
- Managed skills & learning: `capability_skill_*` (`list`/`read`/`create`/`edit`/`adopt`/`lifecycle`/`delete`), `capability_installation_skill_files_{read,write}`, `capability_learning_{status,configure,run,cancel}`
- Capabilities & installations: `capability_bot_{list,get,binding_set}`, `capability_installation_{list,get,deployments,diagnose,updates_check,config_set,sharing_set,toggle,update,uninstall}`, `capability_operation_get`
- Collaboration & other-Bot queue/edit controls: `collaboration_*` (`list_scopes`, `get_scope`, `create_room`, `rename_room`, `update_room_members`, `leave_room`, `delete_room`, `withdraw_queued`, `steer_queued`, `edit_message`, `stop_work`, `resume_work`)

Legacy local tools stay available where only they provide local behavior or for compatibility: `send_to` / `ensure_dm` / `list_scopes` / `read_scope` for local collaboration messaging (`collaboration_publish_room_message` is MCP-only), local `set_bot_soul` to queue self-SOUL edits safely mid-turn, and `manage_bot_skill` / `manage_bot_learning` / `manage_bot_installation` (including `install`/`catalog`/`describe`/`probe`). Load the matching file under `references/` (resolve paths against this skill's directory) for detailed workflows.

## Hard rules

- `capability_skill_*` and `manage_bot_skill` may omit `deviceId`/`botId` to target the current Bot's own skills, or pass both to manage another Bot. All other management tools take explicit `deviceId` + `botId` (resolve via `pibot_bots_list` or `list_bots` first; never guess a target or let one Bot's fields bleed into another).
- Skill `create`/`edit`/`adopt` (and `manage_bot_skill` `create`/`update`/`patch`/`adopt`) save and activate in one step without `expectedRevision` or a separate `publish` call. Other CAS mutations (`pibot_bot_set_model`, `pibot_bot_set_soul`, `capability_bot_binding_set`, `capability_learning_configure`, and legacy equivalents) read first and pass `expectedRevision` (local `set_bot_soul` auto-reads when omitted). A revision conflict means re-read and retry — never force or silently retry with a stale value.
- Receipts are honest states, not wishes: `saved`/`applied` means done; `queued`, `waiting-idle`, `enabling`, or a running learning job means accepted but NOT live; `failed` is terminal for that operation. Never describe a queued deploy or a started job as a finished change.
- A receipt does not start a task; an accepted install does not mean a Bot is enabled; a device deployment receipt is what confirms the device-applied version.
- A Bot cannot abort, clear history, compact, withdraw/steer/edit queued primary messages, stop collaboration work, archive, or delete itself (`collaboration_withdraw_queued` / `collaboration_steer_queued` / `collaboration_edit_message` require valid device management delegation and target another Bot only). Editing its own SOUL mid-turn must use local `set_bot_soul`, which queues to the next safe idle boundary and reports that status.
- Learning never rewrites SOUL; SOUL stays user-requested management only.

## Load a reference when the task matches

| File | Load when |
| --- | --- |
| `references/bots.md` | Create, inspect, configure (profile/SOUL/model/capabilities), interrupt, archive, or delete a Bot (`pibot_bot_*` / local `set_bot_soul` & legacy aliases) |
| `references/skills.md` | Read, create, update, patch, pin/lock, archive/restore, delete, or adopt a Bot's managed skill (`capability_skill_*` / legacy `manage_bot_skill`) |
| `references/learning.md` | Check, configure, start, follow, or cancel Bot learning jobs (`capability_learning_*` / legacy `manage_bot_learning`) |
| `references/installations.md` | Inspect, install, update, enable, or remove capability packages (`capability_installation_*` / legacy `manage_bot_installation`) |
