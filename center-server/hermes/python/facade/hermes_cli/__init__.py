"""Adapter hermes_cli package: the managed worker provides only the pieces the
vendored learning modules import (config, runtime_provider, plugins,
observability.shared_metrics_loop). The package path is extended onto the
vendored hermes_cli/ subtree so byte-exact upstream helpers (sizefmt) resolve
through this namespace too.
"""

import os as _os

_VENDOR_SUBTREE = _os.path.abspath(
    _os.path.join(_os.path.dirname(__file__), "..", "..", "..", "vendor", "hermes_cli"))
if _os.path.isdir(_VENDOR_SUBTREE) and _VENDOR_SUBTREE not in __path__:
    __path__.append(_VENDOR_SUBTREE)
