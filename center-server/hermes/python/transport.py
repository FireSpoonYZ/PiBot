"""NDJSON bridge between this Hermes learning worker and the Node supervisor.

One job per process. Python -> Node on fd 1 (the ORIGINAL stdout descriptor,
written with os.write so the vendored ``thread_scoped_silence`` proxies and
``contextlib.redirect_stdout`` can never corrupt the protocol), Node -> Python
on stdin. A daemon reader thread dispatches call responses and cancel requests;
the job itself runs on the main thread.

Message shapes:
  out: {"type":"call","id":N,"method":M,"params":P}
  out: {"type":"log","level":L,"message":S}
  out: {"type":"result","result":R}   (terminal)
  in : {"type":"response","id":N,"result":R} | {"type":"response","id":N,"error":{code,message}}
  in : {"type":"cancel"}
"""

from __future__ import annotations

import itertools
import json
import os
import queue
import sys
import threading

MAX_LINE_BYTES = 64 * 1024 * 1024


class TransportError(Exception):
    """Bridge-level failure (protocol violation, peer error, lost supervisor)."""

    def __init__(self, message, *, code="HERMES_PROTOCOL"):
        super().__init__(message)
        self.code = code


class Cancelled(TransportError):
    """Raised inside the job when the supervisor cancelled it."""

    def __init__(self, message="job cancelled"):
        super().__init__(message, code="CANCELLED")


_OUT_FD = 1
_write_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending = {}
_ids = itertools.count(1)
_cancel_event = threading.Event()
_eof = threading.Event()


def cancelled():
    return _cancel_event.is_set()


def cancel_event():
    return _cancel_event


def _write_all(data):
    with _write_lock:
        view = memoryview(data)
        while view:
            view = view[os.write(_OUT_FD, view):]


def send(message):
    data = (json.dumps(message, ensure_ascii=False) + chr(10)).encode("utf-8")
    if len(data) > MAX_LINE_BYTES:
        raise TransportError("outbound protocol line exceeds byte bound", code="PAYLOAD_TOO_LARGE")
    _write_all(data)


def log(level, message):
    """Structured log line for the supervisor (best-effort; never raises)."""
    try:
        send({"type": "log", "level": str(level), "message": str(message)})
    except Exception:
        pass


def fail_pending(exc):
    """Wake every blocked ``call()`` with *exc* (cancel / supervisor EOF)."""
    with _pending_lock:
        pending = list(_pending.values())
    for q in pending:
        try:
            q.put_nowait(exc)
        except queue.Full:
            pass


def call(method, params):
    """Send one request to the supervisor and block for its response."""
    if _cancel_event.is_set():
        raise Cancelled()
    if _eof.is_set() and not _pending:
        raise TransportError("supervisor stdin closed", code="SUPERVISOR_GONE")
    call_id = next(_ids)
    q = queue.Queue(maxsize=1)
    with _pending_lock:
        _pending[call_id] = q
    try:
        send({"type": "call", "id": call_id, "method": method, "params": params})
        outcome = q.get()
    finally:
        with _pending_lock:
            _pending.pop(call_id, None)
    if isinstance(outcome, BaseException):
        raise outcome
    kind, payload = outcome
    if kind == "result":
        return payload
    error = payload if isinstance(payload, dict) else {}
    code = error.get("code") or "CALL_FAILED"
    if code == "CANCELLED":
        raise Cancelled(error.get("message") or "call cancelled")
    raise TransportError(error.get("message") or str(method) + " failed", code=code)


def _dispatch(message):
    mtype = message.get("type")
    if mtype == "response":
        call_id = message.get("id")
        with _pending_lock:
            q = _pending.get(call_id)
        if q is None:
            return
        if "error" in message and message["error"] is not None:
            outcome = ("error", message["error"])
        else:
            outcome = ("result", message.get("result"))
        try:
            q.put_nowait(outcome)
        except queue.Full:
            pass
    elif mtype == "cancel":
        _cancel_event.set()
        fail_pending(Cancelled())


def reader_loop():
    """Daemon stdin reader: responses and cancellation. EOF fences the job."""
    stream = sys.stdin.buffer
    try:
        while True:
            line = stream.readline()
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                _cancel_event.set()
                fail_pending(TransportError("inbound protocol line exceeds byte bound",
                                            code="PAYLOAD_TOO_LARGE"))
                return
            try:
                message = json.loads(line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if isinstance(message, dict):
                _dispatch(message)
    finally:
        _eof.set()
        _cancel_event.set()
        fail_pending(TransportError("supervisor stdin closed", code="SUPERVISOR_GONE"))
