"""English-only i18n adapter for the managed PiBot worker.

Upstream resolves layered locale catalogs; this runtime ships the bundled
English strings (locales/en.yaml, display.review.*) for exactly the keys the
vendored learning modules reference. Missing keys degrade the upstream way:
the bare key is returned, then any {placeholder} formatting is applied.
LEARNING_LANGUAGE / display.language is not honored here — the center owns the
user-facing surface.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

DEFAULT_LANGUAGE = "en"
SUPPORTED_LANGUAGES = ("en",)

# locales/en.yaml (display.review.*), pinned upstream commit — verbatim values.
_CATALOG = {
    "display.review.routing_fallback_warning":
        "⚠ auxiliary.background_review.provider='{task_provider}' (model '{task_model}') could not be routed ({error}); falling back to {provider}/{model}",
    "display.review.reasoning_effort_warning":
        "⚠ auxiliary.background_review.reasoning_effort='{effort}' has no effect while the review model is not the main model",
    "display.review.memory_op_line": "{label} {glyph} {preview}",
    "display.review.skill_patched_verbose": "📝 Skill '{name}' patched: \"{old}\" → \"{new}\"",
    "display.review.skill_changed_verbose": "📝 Skill '{name}' {verb}: {description}",
    "display.review.skill_message_verbose": "📝 {message}",
    "display.review.skill_action": "Skill {action}",
    "display.review.label_updated": "{label} updated",
    "display.review.skill_result": "Skill '{name}' {verb}{path}",
    "display.review.skill_verb.created": "created",
    "display.review.skill_verb.rewritten": "rewritten",
    "display.review.skill_verb.patched": "patched",
    "display.review.skill_verb.written": "written",
    "display.review.skill_verb.removed": "removed",
    "display.review.skill_verb.deleted": "deleted",
    "display.review.label.skill": "Skill",
    "display.review.label.memory": "Memory",
    "display.review.label.user": "User profile",
    "display.review.summary_cli": "  💾 Self-improvement review: {summary}",
    "display.review.summary_callback": "💾 Self-improvement review: {summary}",
    "display.review.aux_failure_label": "background review",
}


def get_language() -> str:
    return DEFAULT_LANGUAGE


def reset_language_cache() -> None:
    """No catalog state exists to invalidate."""


def t(key: str, lang=None, **format_kwargs) -> str:
    value = _CATALOG.get(key)
    if value is None:
        logger.debug("i18n miss: key=%r", key)
        value = key
    if not format_kwargs:
        return value
    try:
        return value.format(**format_kwargs)
    except (KeyError, IndexError, ValueError) as exc:
        logger.warning("i18n format failed for key=%r kwargs=%r: %s", key, format_kwargs, exc)
        return value


__all__ = ["DEFAULT_LANGUAGE", "SUPPORTED_LANGUAGES", "get_language",
           "reset_language_cache", "t"]
