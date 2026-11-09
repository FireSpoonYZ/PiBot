"""Adapter for tools/skill_lock: lock membership is answered by the center's
locked-skill name list (the same list the vendored implementation reads from
its usage sidecar). The upstream fallback that resolved frontmatter names
through the local skills tree is intentionally absent — there is no skill
filesystem here, so an unknown name is simply 'not listed as locked'.
"""

from __future__ import annotations

import os
from typing import Iterable


def is_locked_skill(name: str, locked_names: Iterable[str] | None = None) -> bool:
    """Whether *name* (or its basename, matching upstream semantics) is locked."""
    from tools import skill_usage as _su
    names = set(_su.locked_skill_names() if locked_names is None else locked_names)
    if not names:
        return False
    return name in names or os.path.basename(name) in names


def locked_skill_dirs() -> list:
    """No filesystem-backed lock dirs exist in this runtime."""
    return []


def __getattr__(name: str):
    raise AttributeError(
        "tools.skill_lock." + name + " is not supported by the center bridge adapter"
    )
