"""Center-backed adapter replacing upstream agent/curator_backup.py.

Upstream snapshots the local ~/.pibot-learning/skills tree before a mutating pass. In
this runtime the Bot's skills live in the center skill service, so whole-library
backups are unnecessary and these functions are lightweight no-ops.
"""

from __future__ import annotations

DEFAULT_KEEP = 2  # kept for API parity with the vendored module


def snapshot_skills(reason="manual", *, protect_ids=None):
    return {"id": "noop"}


def prune_old_snapshots() -> list:
    return []


def __getattr__(name: str):
    raise AttributeError(
        "agent.curator_backup." + name + " is not supported by the center "
        "bridge adapter"
    )
