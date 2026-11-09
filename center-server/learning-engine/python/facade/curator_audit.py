"""Curator-only operation audit; never a transcript for model execution or replay."""

from __future__ import annotations

import json


def _json_object(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def project_curator_audit(messages):
    receipts = {
        message["tool_call_id"]: _json_object(message.get("content"))
        for message in messages
        if isinstance(message, dict) and message.get("role") == "tool"
        and isinstance(message.get("tool_call_id"), str)
    }
    calls = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        for call in message.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            function = call.get("function") or {}
            if function.get("name") != "skill_manage":
                calls.append(call)
                continue
            operations = _json_object(function.get("arguments")).get("operations")
            receipt = receipts.get(call.get("id"), {})
            results = receipt.get("results")
            # Prefix successes in a rolled-back batch are not committed operations.
            if (not isinstance(operations, list) or not isinstance(results, list)
                    or receipt.get("rolled_back") is True
                    or not (receipt.get("success") is True or receipt.get("draftSaved") is True)
                    or receipt.get("operations_applied") != len(operations)
                    or len(results) != len(operations)):
                continue
            if not all(
                isinstance(op, dict) and isinstance(result, dict)
                and result.get("success") is True
                and result.get("action") == op.get("action")
                and result.get("name") == op.get("name")
                for op, result in zip(operations, results)
            ):
                continue
            for op in operations:
                # Identity only: bodies must not push declarations past vendor's 400-character cap.
                identifiers = {
                    key: op[key].strip()
                    for key in ("action", "name", "absorbed_into")
                    if isinstance(op.get(key), str)
                }
                calls.append({"function": {
                    "name": "skill_manage",
                    "arguments": json.dumps(identifiers, ensure_ascii=False, separators=(",", ":")),
                }})
    return [{"role": "assistant", "tool_calls": calls}]
