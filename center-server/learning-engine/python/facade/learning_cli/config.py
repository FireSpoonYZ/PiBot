"""Adapter: config.yaml is the bound worker config, not a file.

The vendored safe_worker_policy module freezes the job config supplied by the
supervisor (_bind_worker_config runs before any runtime import); every config
reader here returns that snapshot. No config path is ever read from disk.
"""

from __future__ import annotations


def load_config_readonly() -> dict:
    from agent.safe_worker_policy import worker_config_snapshot
    snap = worker_config_snapshot()
    return dict(snap) if isinstance(snap, dict) else {}


def cfg_get(*path, default=None):
    node = load_config_readonly()
    for key in path:
        node = node.get(key) if isinstance(node, dict) else None
    return default if node is None else node


def __getattr__(name: str):
    raise AttributeError(
        "learning_cli.config." + name + " is not supported by the managed worker "
        "adapter (no config.yaml file exists)"
    )
