"""Mode drivers for the Bot learning worker.

review -> agent.background_review.spawn_background_review_thread (the original
          thread target, run synchronously in this one-job process)
learn  -> agent.learn_prompt.build_learn_prompt, executed via one agent.run
curate -> agent.curator.run_curator_review / should_run_now + claim gate
"""

from __future__ import annotations

import threading
import traceback

import transport


class _UsageCapture:
    """Stand-in for upstream session_db's auxiliary-usage sink: the vendored
    _record_review_usage_to_parent writes the fork's counters here instead of
    a state DB (there is none), so usage still reaches the job result."""

    def __init__(self) -> None:
        self.entries = []

    def record_auxiliary_usage(self, session_id, task=None, model=None,
                               billing_provider=None, billing_base_url=None,
                               estimated_cost_usd=None, api_call_count=0, **counts) -> None:
        entry = {
            "session_id": session_id, "task": task, "model": model,
            "provider": billing_provider, "base_url": billing_base_url,
            "estimated_cost_usd": estimated_cost_usd,
            "api_calls": int(api_call_count or 0),
        }
        entry.update({k: int(v or 0) for k, v in counts.items()})
        self.entries.append(entry)


def _usage_snapshot(agent) -> dict:
    keys = ("input_tokens", "output_tokens", "cache_read_tokens",
            "cache_write_tokens", "reasoning_tokens", "api_calls")
    out = {"model": agent.model, "provider": agent.provider,
           "base_url": agent.base_url,
           "estimated_cost_usd": agent.session_estimated_cost_usd}
    for key in keys:
        out[key] = int(getattr(agent, "session_" + key, 0) or 0)
    return out


def _parent_agent(snapshot: dict, config: dict):
    """Fabricate the 'live' agent the review fork branches off, seeded from the
    Host-supplied snapshot (model, system prompt, transcript, tool schemas)."""
    from run_agent import AIAgent

    agent = AIAgent(
        model=snapshot.get("model"), provider=snapshot.get("provider"),
        quiet_mode=True, platform=snapshot.get("platform") or "bot",
        request_overrides={},
        reasoning_config=(config.get("reasoningConfig")
                          or config.get("reasoning_config")),
    )
    agent.session_id = snapshot.get("sessionId") or ""
    agent._parent_session_id = ""
    agent._memory_enabled = agent._user_profile_enabled = bool(
        snapshot.get("memoryEnabled"))
    agent._memory_store = None
    agent._cached_system_prompt = snapshot.get("systemPrompt") or None
    tools = config.get("tools")
    if not isinstance(tools, list):
        tools = snapshot.get("tools")
    if isinstance(tools, list):
        agent.tools = list(tools)
        agent.valid_tool_names = {
            d["function"]["name"] for d in agent.tools
            if isinstance(d, dict) and isinstance(d.get("function"), dict)
            and d["function"].get("name")
        }
    agent.memory_notifications = config.get("notificationMode") or "on"
    return agent


def _run_review(snapshot: dict, focus, config: dict) -> dict:
    from agent import background_review as review

    agent = _parent_agent(snapshot, config)
    agent._session_db = _UsageCapture()
    agent.background_review_callback = agent._emitted_lines.append

    # Original enable gate (safe-worker / finite-turn / config flag).
    enabled, task_cfg = review.load_background_review_settings()
    if not enabled:
        return {"summary": "background review disabled",
                "result": {"skipped": "disabled"}}

    memory_flag = snapshot.get("memoryEnabled")
    review_memory = bool(memory_flag) if config.get("reviewMemory") is None \
        else bool(config.get("reviewMemory"))
    review_skills = True if config.get("reviewSkills") is None \
        else bool(config.get("reviewSkills"))
    run = review.prepare_background_review_run(agent)
    if run is None:
        return {"error": {"code": "BUSY",
                          "message": "a background review is already active"}}
    target, _prompt = review.spawn_background_review_thread(
        agent, snapshot.get("messages") or [],
        review_memory=review_memory, review_skills=review_skills, focus=focus,
        task_cfg=task_cfg, review_run=run,
        explicit=not config.get("automatic"))

    # Cancellation: the original live-turn preemption path, driven by the
    # supervisor's cancel message. 'finished' keeps a normal completion from
    # being re-cancelled when the watcher is released.
    finished = threading.Event()

    def _watch():
        transport.cancel_event().wait()
        if finished.is_set():
            return
        try:
            review.cancel_background_review_for_live_turn(
                agent, message="cancelled by supervisor",
                tool_reason="learning job cancelled")
        except Exception:
            pass

    watcher = threading.Thread(target=_watch, daemon=True,
                               name="learning-review-cancel")
    watcher.start()
    try:
        target()  # the original daemon-thread body, run synchronously
    finally:
        finished.set()
        transport.cancel_event().set()  # release the watcher
        watcher.join(timeout=2.0)

    emitted = [line for line in agent._emitted_lines if line]
    usage_entries = agent._session_db.entries if agent._session_db else []
    # _run_review_in_thread swallows the fork's exception and reports it only
    # through agent._emit_auxiliary_failure — surfaced by the facade here so a
    # failed review can never resolve as a silent success.
    if agent._auxiliary_failures:
        return {
            "error": {"code": "REVIEW_FAILED",
                      "message": agent._auxiliary_failures[-1]},
            "actions": emitted,
            "usage": usage_entries[-1] if usage_entries else _usage_snapshot(agent),
            "result": {"usage_entries": usage_entries,
                       "auxiliary_failures": list(agent._auxiliary_failures)},
        }
    return {
        "summary": emitted[-1] if emitted else "",
        "actions": emitted,
        "usage": usage_entries[-1] if usage_entries else _usage_snapshot(agent),
        "result": {"usage_entries": usage_entries},
    }


def _run_learn(snapshot: dict, focus, config: dict) -> dict:
    from agent.learn_prompt import build_learn_prompt

    agent = _parent_agent(snapshot, config)
    if not config.get("maxIterations"):
        config_max = 32
    else:
        config_max = int(config.get("maxIterations"))
    agent.max_iterations = config_max
    request = focus or config.get("request") or ""
    prompt = build_learn_prompt(request)
    conv = agent.run_conversation(
        user_message=prompt,
        conversation_history=snapshot.get("messages") or [])
    return {
        "summary": conv.get("final_response") or "",
        "usage": _usage_snapshot(agent),
        "result": conv,
    }


def _run_curate(snapshot: dict, focus, config: dict) -> dict:
    from agent import curator

    summaries = []

    def _on_summary(message):
        summaries.append(str(message))
        transport.log("info", message)

    automatic = bool(config.get("automatic"))
    dry_run = bool(config.get("dryRun") or config.get("dry_run"))
    consolidate = config.get("consolidate")
    consolidate = None if consolidate is None else bool(consolidate)

    # The original pass catches LLM errors and returns them in its metadata.
    # Capture that metadata without depending on a best-effort report file.
    consolidation_pass = curator._consolidation_pass
    llm_errors = []

    def _capture_consolidation(*args, **kwargs):
        summary, meta = consolidation_pass(*args, **kwargs)
        if meta.get("error"):
            llm_errors.append(str(meta["error"]))
        return summary, meta

    curator._consolidation_pass = _capture_consolidation
    try:
        if automatic:
            idle = config.get("idleForSeconds")
            if not curator.should_run_now() or (
                    idle is not None and idle < curator.get_min_idle_hours() * 3600.0):
                return {"summary": "curator not due",
                        "result": {"skipped": "not_due", "state": curator.load_state()}}
            # The original claim/gate sequence remains synchronous.
            if not curator._claim_run():
                return {"summary": "another curator run holds the claim",
                        "result": {"skipped": "claim_held", "state": curator.load_state()}}
            try:
                outcome = curator.run_curator_review(
                    on_summary=_on_summary, synchronous=True, dry_run=dry_run,
                    consolidate=consolidate, trigger="scheduled")
            finally:
                curator._release_run_claim()
        else:
            outcome = curator.run_curator_review(
                on_summary=_on_summary, synchronous=True, dry_run=dry_run,
                consolidate=consolidate, trigger=config.get("trigger") or "manual")
    finally:
        curator._consolidation_pass = consolidation_pass

    state = curator.load_state()
    result = {
        "summary": summaries[-1] if summaries else outcome.get("summary_so_far", ""),
        "result": {
            **outcome,
            "summaries": summaries,
            "state": state,
        },
    }
    if llm_errors:
        result["error"] = {"code": "CURATOR_LLM_ERROR", "message": llm_errors[-1]}
    return result


def run(job: dict) -> dict:
    mode = job.get("mode")
    snapshot = job.get("snapshot") or {}
    focus = job.get("focus")
    config = job.get("config") or {}
    if mode == "review":
        return _run_review(snapshot, focus, config)
    if mode == "learn":
        return _run_learn(snapshot, focus, config)
    if mode == "curate":
        return _run_curate(snapshot, focus, config)
    return {"error": {"code": "INVALID_ARGUMENT",
                      "message": "unknown learning mode: " + str(mode)}}


def error_result(exc: BaseException) -> dict:
    code = getattr(exc, "code", None) or "LEARNING_ERROR"
    tail = traceback.format_exc().splitlines()[-8:]
    return {"error": {"code": str(code), "message": str(exc),
                      "traceback": tail}}
