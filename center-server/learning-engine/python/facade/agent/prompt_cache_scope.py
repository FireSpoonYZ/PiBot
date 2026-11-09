"""Adapter: no session DB, compression lineage or declared gateway key exists
in this runtime, so there is no cache scope to resolve. Returning None matches
upstream's own 'nothing resolved' path (the caller skips the inheritance)."""

from __future__ import annotations


def resolve_prompt_cache_scope_safe(agent=None, *args, **kwargs):
    return None


__all__ = ["resolve_prompt_cache_scope_safe"]
