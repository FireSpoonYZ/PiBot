"""Adapter: auxiliary-model routing without a credential chain.

A different (provider, model) is forwarded verbatim — the Host decides whether
it can serve it and reports an honest error otherwise. Requests that would need
secret/base-url resolution here (explicit api_key/base_url) raise; the vendored
callers catch that and fall back to the main model with a visible warning.
"""

from __future__ import annotations


def resolve_runtime_provider(requested=None, target_model=None,
                             explicit_api_key=None, explicit_base_url=None, **_kwargs) -> dict:
    if explicit_api_key or explicit_base_url:
        raise RuntimeError(
            "auxiliary routing with explicit credentials is not supported by the "
            "managed PiBot worker"
        )
    return {"provider": requested, "model": target_model}
