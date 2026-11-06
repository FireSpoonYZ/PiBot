"""Adapter: the dispatch-side review tool whitelist.

Vendored code installs a thread-local whitelist before a review fork runs;
the facade's run_conversation reads it back to build agent.run's allowedTools.
The deny message is unused — dispatch lives on the Host — but the argument is
accepted to keep the upstream call shape.
"""

from __future__ import annotations

import threading

_thread_tool_whitelist = threading.local()


def set_thread_tool_whitelist(allowed, deny_msg_fmt=None) -> None:
    _thread_tool_whitelist.allowed = allowed
    _thread_tool_whitelist.fmt = deny_msg_fmt


def clear_thread_tool_whitelist() -> None:
    _thread_tool_whitelist.allowed = None


def current_thread_tool_whitelist():
    return getattr(_thread_tool_whitelist, "allowed", None)


def __getattr__(name: str):
    raise AttributeError(
        "hermes_cli.plugins." + name + " is not supported by the managed worker adapter"
    )
