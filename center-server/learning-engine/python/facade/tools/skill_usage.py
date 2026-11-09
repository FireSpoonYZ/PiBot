"""Center-backed adapter replacing upstream tools/skill_usage.py.

There is no local ~/.pibot-learning/skills tree in this runtime: the Bot's managed
skills live in the center skill service. Every storage/telemetry call the
vendored curator makes is forwarded over the bridge as
method='skill.call', params={name:'skill_usage.<fn>', args:{...}} and answered
by the center-side PiBot skill adapter. Function names and argument shapes
mirror the upstream module; anything not listed raises AttributeError loudly
instead of silently touching a filesystem.

Expected center replies (contract for the skills service):
  curated_report()            -> list[dict] rows with keys:
                               name, state, pinned, locked, provenance,
                               use_count, activity_count, view_count,
                               patch_count, last_activity_at, created_at,
                               first_seen_at, _persisted
  set_state(name, state)      -> null
  archive_skill(name)         -> [ok, message] or {success, message}
  restore_skill(name)         -> [ok, message] or {success, message}
  seed_record_if_missing(name)-> null
  reanchor_clock(name)        -> null
  locked_skill_names()        -> list[str]
  is_bundled(name)            -> bool
  is_locked(name)             -> bool
  is_protected_builtin(name)  -> bool
  is_agent_created(name)      -> bool
  is_hub_installed(name)      -> bool
  is_curation_eligible(name)  -> bool
  is_curator_managed(name)    -> bool
  is_external_only(name)      -> bool
  provenance(name)            -> 'agent' | 'bundled' | 'hub' | 'external'
  set_pinned(name, pinned)    -> bool
  set_locked(name, locked)    -> bool
  forget(name)                -> null
  bump_view(name)             -> null
  bump_use(name, ...)         -> null
  bump_patch(name, ...)       -> null
  record_created(name, ...)   -> null
  record_installed(name)      -> null
  mark_agent_created(name)    -> null
  adopt_skill(name)           -> [ok, message] or {success, message}
  usage_report()              -> list[dict]
  unmanaged_report()          -> list[dict]
  list_agent_created_skill_names() -> list[str]
  list_archived_skill_names()      -> list[str]
  list_unmanaged_skill_names()     -> list[str]
"""

from __future__ import annotations

import transport

# Same protocol values the upstream module defines.
STATE_ACTIVE, STATE_STALE, STATE_ARCHIVED = "active", "stale", "archived"


def _call(fn: str, **args):
    return transport.call("skill.call", {"name": "skill_usage." + fn, "args": args})


def _ok_message(result):
    if isinstance(result, (list, tuple)):
        ok = bool(result[0]) if result else False
        msg = str(result[1]) if len(result) > 1 else ""
        return ok, msg
    if isinstance(result, dict):
        ok = result.get("success", result.get("ok"))
        return bool(ok), str(result.get("message") or result.get("detail") or "")
    return bool(result), ""


def curated_report() -> list:
    return _call("curated_report") or []


def usage_report() -> list:
    return _call("usage_report") or []


def unmanaged_report() -> list:
    return _call("unmanaged_report") or []


def set_state(skill_name: str, state: str) -> None:
    _call("set_state", name=skill_name, state=state)


def archive_skill(skill_name: str):
    return _ok_message(_call("archive_skill", name=skill_name))


def restore_skill(skill_name: str):
    return _ok_message(_call("restore_skill", name=skill_name))


def seed_record_if_missing(skill_name: str) -> None:
    _call("seed_record_if_missing", name=skill_name)


def reanchor_clock(skill_name: str) -> None:
    _call("reanchor_clock", name=skill_name)


def locked_skill_names() -> list:
    return list(_call("locked_skill_names") or [])


def is_bundled(skill_name: str) -> bool:
    return bool(_call("is_bundled", name=skill_name))


def is_locked(skill_name: str) -> bool:
    return bool(_call("is_locked", name=skill_name))


def is_protected_builtin(skill_name: str) -> bool:
    return bool(_call("is_protected_builtin", name=skill_name))


def is_agent_created(skill_name: str) -> bool:
    return bool(_call("is_agent_created", name=skill_name))


def is_hub_installed(skill_name: str) -> bool:
    return bool(_call("is_hub_installed", name=skill_name))


def is_curation_eligible(skill_name: str, skill_path=None) -> bool:
    return bool(_call("is_curation_eligible", name=skill_name))


def is_curator_managed(skill_name: str) -> bool:
    return bool(_call("is_curator_managed", name=skill_name))


def is_external_only(skill_name: str) -> bool:
    return bool(_call("is_external_only", name=skill_name))


def provenance(skill_name: str) -> str:
    return str(_call("provenance", name=skill_name) or "agent")


def set_pinned(skill_name: str, pinned: bool) -> bool:
    return bool(_call("set_pinned", name=skill_name, pinned=bool(pinned)))


def set_locked(skill_name: str, locked: bool) -> bool:
    return bool(_call("set_locked", name=skill_name, locked=bool(locked)))


def forget(skill_name: str) -> None:
    _call("forget", name=skill_name)


def bump_view(skill_name: str) -> None:
    _call("bump_view", name=skill_name)


def bump_use(skill_name: str, *, task_id=None, session_id=None) -> None:
    _call("bump_use", name=skill_name, task_id=task_id, session_id=session_id)


def bump_patch(skill_name: str, *, action="patch", task_id=None, session_id=None) -> None:
    _call("bump_patch", name=skill_name, action=action, task_id=task_id, session_id=session_id)


def record_created(skill_name: str, *, agent_created: bool, task_id=None, session_id=None) -> None:
    _call("record_created", name=skill_name, agent_created=bool(agent_created),
          task_id=task_id, session_id=session_id)


def record_installed(skill_name: str) -> None:
    _call("record_installed", name=skill_name)


def mark_agent_created(skill_name: str) -> None:
    _call("mark_agent_created", name=skill_name)


def adopt_skill(skill_name: str):
    return _ok_message(_call("adopt_skill", name=skill_name))


def list_agent_created_skill_names() -> list:
    return list(_call("list_agent_created_skill_names") or [])


def list_archived_skill_names() -> list:
    return list(_call("list_archived_skill_names") or [])


def list_unmanaged_skill_names() -> list:
    return list(_call("list_unmanaged_skill_names") or [])


def __getattr__(name: str):
    raise AttributeError(
        "tools.skill_usage." + name + " has no center-backed adapter; the managed "
        "worker keeps no local skill store or usage sidecar"
    )
