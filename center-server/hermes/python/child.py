"""Managed Hermes learning worker — one job per process.

Bootstrap order is load-bearing:
  1. read the init line from stdin (mode / snapshot / focus / config / stateDir)
  2. vendor dir first on sys.path so the agent/tools package __init__ files are
     the ORIGINAL upstream ones; facade dir second for adapter + top modules
  3. bind the job config through the vendored safe_worker_policy before any
     runtime import (its own contract: bind first, readers see the snapshot)
  4. merge the facade submodule dirs into the vendored agent/tools packages so
     agent.i18n, tools.skill_usage, ... resolve to bridge adapters while
     agent.background_review, agent.curator, ... stay byte-exact upstream
  5. run the mode driver on this thread; a daemon reader thread owns stdin
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_FACADE = os.path.join(_HERE, "facade")
_VENDOR = os.path.abspath(os.path.join(_HERE, "..", "vendor"))


def _read_init():
    line = sys.stdin.buffer.readline()
    if not line:
        return None
    message = json.loads(line)
    if not isinstance(message, dict) or message.get("type") != "init":
        raise RuntimeError("first protocol line must be the init message")
    job = message.get("job")
    if not isinstance(job, dict):
        raise RuntimeError("init message carries no job object")
    return job


def _merge_facade_subpackages() -> None:
    import agent
    import tools
    for package, subdir in ((agent, "agent"), (tools, "tools")):
        extra = os.path.join(_FACADE, subdir)
        if os.path.isdir(extra) and extra not in package.__path__:
            package.__path__.insert(0, extra)


def main() -> int:
    import transport

    try:
        job = _read_init()
    except Exception as exc:
        transport.send({"type": "result",
                        "result": {"error": {"code": "HERMES_INIT",
                                             "message": str(exc)}}})
        return 1
    if job is None:
        return 1

    sys.path.insert(0, _FACADE)
    sys.path.insert(0, _VENDOR)

    state_dir = job.get("stateDir")
    if isinstance(state_dir, str) and state_dir:
        os.environ["HERMES_HOME"] = state_dir

    # Bind the job config BEFORE the learning modules import config readers.
    config = job.get("config") or {}
    snapshot = job.get("snapshot") or {}
    if job.get("mode") == "curate":
        config = dict(config)
        model_config = dict(config.get("model") or {})
        if snapshot.get("provider"):
            model_config["provider"] = snapshot["provider"]
        if snapshot.get("model"):
            model_config["default"] = snapshot["model"]
        config["model"] = model_config
        job["config"] = config
    from agent.safe_worker_policy import _bind_worker_config
    _bind_worker_config(config)

    _merge_facade_subpackages()

    import model_tools
    tools = config.get("tools")
    if not isinstance(tools, list):
        tools = snapshot.get("tools")
    model_tools.set_job_tools(tools or [])

    reader = threading.Thread(target=transport.reader_loop, daemon=True,
                              name="hermes-stdin-reader")
    reader.start()

    def _on_signal(_signum, _frame):
        transport.cancel_event().set()
        transport.fail_pending(transport.Cancelled("terminated by signal"))

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    import driver
    try:
        result = driver.run(job)
    except transport.Cancelled as exc:
        result = {"error": {"code": "CANCELLED", "message": str(exc)}}
    except BaseException as exc:  # noqa: BLE001 — surfaced as the job result
        result = driver.error_result(exc)
    try:
        transport.send({"type": "result", "result": result})
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
