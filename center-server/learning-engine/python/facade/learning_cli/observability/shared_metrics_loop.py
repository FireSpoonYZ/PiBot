"""Adapter: curator run metrics have no metrics backend here.

The run record is forwarded to the supervisor as a structured protocol log
line so the information is not silently dropped.
"""

from __future__ import annotations

import transport


def record_curator_run(*, trigger=None, outcome=None, counts=None, learning_home=None, **_kwargs) -> None:
    try:
        detail = counts() if callable(counts) else counts
    except Exception:
        detail = {"error": "counts callback failed"}
    transport.log("metric", {
        "kind": "curator_run", "trigger": trigger, "outcome": outcome,
        "counts": detail, "learning_home": str(learning_home) if learning_home else None,
    })
