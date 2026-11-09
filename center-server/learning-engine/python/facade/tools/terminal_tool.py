"""Thread-local approval callback required by PiBot review; no terminal is exposed."""

from threading import local

_state = local()


def set_approval_callback(callback):
    _state.approval_callback = callback


def get_approval_callback():
    return getattr(_state, "approval_callback", None)
