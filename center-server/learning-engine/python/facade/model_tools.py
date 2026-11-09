"""Adapter replacing upstream model_tools.get_tool_definitions.

Tool schemas are supplied by the job (config.tools / snapshot.tools — the
center-provided LEARNING_SKILL_TOOLS plus the restricted read_file/search_files
and optional memory definition), NOT discovered from a tools/ registry. This
module only reproduces the toolset-name filtering the vendored review code
relies on; unknown toolset names resolve to the bare tool of the same name.
"""

from __future__ import annotations

import copy

# Toolset name -> tool names, trimmed to the surface this worker can advertise.
_TOOLSET_TOOLS = {
    "skills": ("skills_list", "skill_view", "skill_manage"),
    "skills_tools": ("skills_list", "skill_view", "skill_manage"),
    "memory": ("memory",),
    "file": ("read_file", "write_file", "patch", "search_files"),
    "file_tools": ("read_file", "write_file", "patch", "search_files"),
}

_job_tools = []


def set_job_tools(definitions) -> None:
    """Install the job's advertised tool schemas (called once by the bootstrap)."""
    global _job_tools
    _job_tools = [d for d in (definitions or []) if isinstance(d, dict)]


def _tool_name(definition) -> str:
    fn = definition.get("function")
    return fn.get("name", "") if isinstance(fn, dict) else ""


def _toolset_names(name):
    tools = _TOOLSET_TOOLS.get(name)
    return set(tools) if tools is not None else {name}


def get_tool_definitions(enabled_toolsets=None, disabled_toolsets=None,
                         quiet_mode=False, skip_tool_search_assembly=False):
    """Tool definitions for model calls, filtered by toolset (upstream ABI).

    enabled_toolsets=None -> every job-provided definition; disabled sets are
    subtracted afterwards, matching upstream semantics.
    """
    defs = list(_job_tools)
    if enabled_toolsets is not None:
        names = set()
        for ts in enabled_toolsets or []:
            names |= _toolset_names(ts)
        defs = [d for d in defs if _tool_name(d) in names]
    if disabled_toolsets:
        drop = set()
        for ts in disabled_toolsets:
            drop |= _toolset_names(ts)
        defs = [d for d in defs if _tool_name(d) not in drop]
    return copy.deepcopy(defs)


__all__ = ["get_tool_definitions", "set_job_tools"]
