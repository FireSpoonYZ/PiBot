"""Adapter: this worker is a supervised per-job process, not a finite gateway
turn and not a safe-mode worker — both gates answer 'no constraint'.
"""

from __future__ import annotations


def finite_turn_required():
    return None


def unattended_turn() -> bool:
    return False


FINITE_CLARIFY_NOTICE = (
    "single-query mode: no user available to answer. Pick the best choices using your own "
    "judgment, or make the most reasonable assumption you can, and continue.")


def finite_clarify_reply() -> dict:
    return {"answers": {}, "outcome": "undelivered", "notice": FINITE_CLARIFY_NOTICE}
