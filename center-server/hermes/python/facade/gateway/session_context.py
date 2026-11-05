"""Adapter: session-scoped environment lookup. There is no multiplexed
session context here, so the process environment is the scope."""

from __future__ import annotations

import os


def get_session_env(name: str, default=None):
    return os.environ.get(name, default)
