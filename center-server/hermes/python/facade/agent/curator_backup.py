"""Center-backed adapter replacing upstream agent/curator_backup.py.

Upstream snapshots the local ~/.hermes/skills tree before a mutating pass. In
this runtime the Bot's skills live in the center skill service, so a local
snapshot would (a) back up a directory that does not exist and (b) claim safety
that was never real. This adapter forwards the same operations over the bridge
as method='skill.call' params={name:'skill_usage.snapshot_skills' |
'skill_usage.prune_old_snapshots', args}. The center stores content and metadata
in its own database. A failed snapshot emits a warning rather than claiming a
backup. Snapshot restore is not exposed here; individual content revisions can
be recovered with the managed skill history and rollback API.
"""

from __future__ import annotations

from types import SimpleNamespace

import transport

DEFAULT_KEEP = 2  # kept for API parity with the vendored module


def snapshot_skills(reason="manual", *, protect_ids=None):
    """Ask the center for a whole-library snapshot; returns a .name-bearing
    handle like upstream (Path.name) or None when skipped/unavailable."""
    try:
        res = transport.call("skill.call", {
            "name": "skill_usage.snapshot_skills",
            "args": {"reason": reason},
        })
    except Exception as e:
        transport.log("warning",
                      "curator snapshot_skills unavailable through the center "
                      "skill service (" + str(e) + ") — continuing WITHOUT a "
                      "pre-run snapshot")
        return None
    if res in (None, False):
        transport.log("warning",
                      "curator snapshot_skills returned no snapshot — "
                      "continuing WITHOUT a pre-run snapshot")
        return None
    name = res if isinstance(res, str) else (
        res.get("id") or res.get("name") or res.get("snapshot")
        if isinstance(res, dict) else str(res))
    return SimpleNamespace(name=str(name))


def prune_old_snapshots() -> list:
    try:
        res = transport.call("skill.call", {
            "name": "skill_usage.prune_old_snapshots", "args": {}})
    except Exception as e:
        transport.log("warning",
                      "curator prune_old_snapshots unavailable through the "
                      "center skill service (" + str(e) + ")")
        return []
    return list(res) if isinstance(res, list) else []


def __getattr__(name: str):
    raise AttributeError(
        "agent.curator_backup." + name + " is not supported by the center "
        "bridge adapter; use managed skill history and rollback"
    )
