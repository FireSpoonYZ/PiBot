"""Facade replacing upstream run_agent.AIAgent for the managed Hermes worker.

There is no live in-process agent here: the real model/tool loop runs on the
Host and is reached through the bridge as ONE bounded agent.run call per
run_conversation. This facade keeps every attribute the vendored learning
modules touch (fork construction, tool-surface inheritance, usage snapshots,
run-token cancellation) so agent.background_review and agent.curator execute
unmodified. Persistence, credential resolution and provider I/O do not exist
in this runtime and are not faked.

threading is re-exported because upstream callers patch
run_agent.threading.Thread (kept for ABI parity).
"""

from __future__ import annotations

import threading  # noqa: F401  (upstream ABI: tests patch run_agent.threading)
from typing import Any, Optional

import transport
import model_tools

_USAGE_COUNTERS = (
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "reasoning_tokens", "api_calls",
)


class AgentCancelled(Exception):
    """The fork's own interrupt was requested (or the supervisor cancelled)."""


class _FacadeClient:
    """Stands in for the provider client so _parent_can_emit_tool_calls
    sees a tool-capable runtime; no network object exists."""

    SUPPORTS_HERMES_TOOL_CALLS = True


class AIAgent:
    """Attribute-compatible stand-in for upstream run_agent.AIAgent.

    run_conversation forwards {prompt, messages, tools, allowedTools,
    maxIterations, maxInputTokens, model, provider, reasoningConfig} through
    the bridge and stores the returned transcript on _session_messages so
    the vendored summarizer / report builders see the original data shapes.
    """

    def __init__(self, **kwargs: Any) -> None:
        # Runtime identity (may be overridden by kwargs; 'auto' means the main model).
        self.provider = kwargs.get("provider")
        if self.provider == "auto":
            self.provider = None
        self.model = kwargs.get("model")
        self.base_url = kwargs.get("base_url")
        self.api_mode = kwargs.get("api_mode")
        self.api_key = kwargs.get("api_key")
        self.credential_pool = kwargs.get("credential_pool")
        self._credential_pool = self.credential_pool
        self.request_overrides = dict(kwargs.get("request_overrides") or {})
        self.max_tokens = kwargs.get("max_tokens")
        self.acp_command = kwargs.get("acp_command")
        self.acp_args = list(kwargs.get("acp_args") or [])
        self.reasoning_config = kwargs.get("reasoning_config")
        self.ephemeral_system_prompt = kwargs.get("ephemeral_system_prompt")
        self.prefill_messages = kwargs.get("prefill_messages")
        for attr in ("providers_allowed", "providers_ignored", "providers_order",
                     "provider_sort", "provider_require_parameters", "provider_data_collection"):
            setattr(self, attr, kwargs.get(attr))

        # Session / platform surface.
        self.platform = kwargs.get("platform")
        self.session_id = None
        self.session_start = None
        self._parent_session_id = kwargs.get("parent_session_id")
        self.quiet_mode = bool(kwargs.get("quiet_mode"))
        self.suppress_status_output = False
        self.skip_memory = bool(kwargs.get("skip_memory"))
        self.skip_context_files = bool(kwargs.get("skip_context_files"))
        self.max_iterations = kwargs.get("max_iterations")

        # Tool surface: explicit toolsets resolve against the job-provided
        # defs; otherwise advertise the full job set (callers may overwrite).
        enabled = kwargs.get("enabled_toolsets")
        self.enabled_toolsets = enabled
        self.disabled_toolsets = kwargs.get("disabled_toolsets")
        self.tools = model_tools.get_tool_definitions(
            enabled_toolsets=list(enabled) if enabled else None,
            disabled_toolsets=list(self.disabled_toolsets) if self.disabled_toolsets else None,
            quiet_mode=True,
        )
        self.valid_tool_names = {
            d["function"]["name"] for d in self.tools
            if isinstance(d, dict) and isinstance(d.get("function"), dict) and d["function"].get("name")
        }

        # Conversation / fork bookkeeping the vendored code reads and writes.
        self._session_messages = []
        self._session_db = None
        self._memory_store = None
        self._memory_enabled = False
        self._user_profile_enabled = False
        self._memory_nudge_interval = 0
        self._skill_nudge_interval = 0
        self._memory_write_origin = "foreground"
        self._memory_write_context = "foreground"
        self._turn_origin = None
        self._review_attended = False
        self._review_input_token_budget = None
        self._skip_mcp_refresh = False
        self._persist_disabled = False
        self._end_session_on_close = True
        self._cached_system_prompt = None
        self._inherited_cache_scope = None
        self._prompt_cache_fork_tag = None
        self._cached_conversation_root = None
        self._tool_snapshot_generation = 0
        self.context_compressor = None
        self.compression_enabled = False
        self.compression_in_place = False
        self._review_defer_compaction_before_first_response = False
        self.client = _FacadeClient()
        self.memory_notifications = "on"
        self.background_review_callback = None
        self._emitted_lines = []
        self._auxiliary_failures = []
        self._warned_bg_review_routing = False
        self._warned_bg_review_reasoning_effort = False
        self._interrupt_requested = False
        self._interrupt_reason = None
        self._background_review_lock = threading.Lock()
        self._background_review_run = None
        self._background_review_agent = None
        self._active_children = []
        self._active_children_lock = threading.Lock()

        # Usage counters the vendored snapshotter reads (session_* shape).
        for key in _USAGE_COUNTERS:
            setattr(self, "session_" + key, 0)
        self.session_estimated_cost_usd = None

    # --- runtime surface the vendored modules read ---------------------------

    def _current_main_runtime(self) -> dict:
        return {}

    def _conversation_root_id(self):
        return self._cached_conversation_root or self.session_id

    # --- user-visible emitters routed to the supervisor log -------------------

    def _safe_print(self, message) -> None:
        self._emitted_lines.append(str(message))
        transport.log("print", message)

    def _emit_warning(self, message) -> None:
        transport.log("warning", message)

    def _emit_auxiliary_failure(self, task, exc) -> None:
        # The vendored _run_review_in_thread swallows the review exception and
        # reports it ONLY through here — a facade that merely logs would turn a
        # failed review into a silent success. Record it (bounded) so the
        # driver can return an honest error result.
        if len(self._auxiliary_failures) < 8:
            self._auxiliary_failures.append(str(task) + ": " + str(exc))
        transport.log("error", str(task) + ": " + str(exc))

    # --- the one real model call --------------------------------------------

    def run_conversation(self, user_message=None, system_message=None,
                         conversation_history=None, **_ignored) -> dict:
        """Execute one bounded conversation turn through the Host.

        Returns {final_response, messages, usage} like upstream; the
        transcript is also stored on _session_messages for the vendored
        action summarizer and curator report builders.
        """
        if self._interrupt_requested or transport.cancelled():
            raise AgentCancelled(self._interrupt_reason or "interrupted")
        try:
            from hermes_cli.plugins import current_thread_tool_whitelist
        except ImportError:
            current_thread_tool_whitelist = None
        whitelist = current_thread_tool_whitelist() if current_thread_tool_whitelist else None
        allowed = sorted(whitelist) if whitelist else sorted(self.valid_tool_names)

        messages = [m for m in (conversation_history or []) if isinstance(m, dict)]
        system_prompt = system_message if system_message is not None else self._cached_system_prompt
        if system_prompt and not (messages and messages[0].get("role") == "system"):
            messages.insert(0, {"role": "system", "content": system_prompt})

        params = {
            "prompt": user_message,
            "messages": messages,
            "allowedTools": allowed,
            "maxIterations": int(self.max_iterations or 16),
        }
        if self.tools:
            params["tools"] = self.tools
        if isinstance(self._review_input_token_budget, int) and self._review_input_token_budget > 0:
            params["maxInputTokens"] = self._review_input_token_budget
        if self.model:
            params["model"] = self.model
        if self.provider:
            params["provider"] = self.provider
        if self.reasoning_config:
            params["reasoningConfig"] = self.reasoning_config

        token = None
        try:
            from tools.skill_provenance import reset_current_write_origin, set_current_write_origin
            token = set_current_write_origin(self._memory_write_origin or "foreground")
        except Exception:
            reset_current_write_origin = None
        try:
            result = transport.call("agent.run", params)
        except transport.Cancelled as exc:
            self._interrupt_requested = True
            raise AgentCancelled(str(exc)) from exc
        finally:
            if token is not None:
                try:
                    reset_current_write_origin(token)
                except Exception:
                    pass
        if self._interrupt_requested:
            raise AgentCancelled(self._interrupt_reason or "interrupted")

        if not isinstance(result, dict):
            raise transport.TransportError("agent.run returned a non-object result")
        messages_out = result.get("messages")
        self._session_messages = list(messages_out) if isinstance(messages_out, list) else []
        usage = result.get("usage") if isinstance(result.get("usage"), dict) else {}
        for key in _USAGE_COUNTERS:
            try:
                setattr(self, "session_" + key,
                        int(getattr(self, "session_" + key, 0) or 0) + int(usage.get(key) or 0))
            except (TypeError, ValueError):
                pass
        if usage.get("estimated_cost_usd") is not None:
            self.session_estimated_cost_usd = usage.get("estimated_cost_usd")
        return {
            "final_response": result.get("final_response") or "",
            "messages": self._session_messages,
            "usage": usage,
        }

    # --- lifecycle / interruption --------------------------------------------

    def release_clients(self) -> None:
        """The fork holds no sockets of its own; retained for upstream parity."""

    def close(self) -> None:
        self.release_clients()

    def interrupt(self, message=None, tool_reason=None) -> None:
        self._interrupt_requested = True
        self._interrupt_reason = message or tool_reason or "interrupted"
        transport.fail_pending(transport.Cancelled(self._interrupt_reason))

    def hard_interrupt(self, message=None, *, tool_reason=None) -> None:
        self.interrupt(message, tool_reason=tool_reason)


__all__ = ["AIAgent", "AgentCancelled"]
