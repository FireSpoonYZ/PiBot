"""Read-only config backend backed exclusively by the bound job snapshot."""

from agent.safe_worker_policy import worker_config_snapshot


def _snapshot():
    snapshot = worker_config_snapshot()
    if snapshot is None:
        raise RuntimeError("Hermes worker config snapshot is not bound")
    return snapshot


def config_exists(_path):
    _snapshot()
    return True


def read_config_doc(_path):
    return _snapshot()


def config_cache_version_or_none(_path):
    _snapshot()
    return None
