"""Only the two cron functions consumed by the vendored curator."""
import transport


def referenced_skill_names() -> set[str]:
    return set(transport.call("schedule.call", {
        "name": "referenced_skill_names", "args": {},
    }))


def rewrite_skill_refs(*, consolidated=None, pruned=None) -> dict:
    return transport.call("schedule.call", {
        "name": "rewrite_skill_refs",
        "args": {"consolidated": consolidated or {}, "pruned": pruned or []},
    })
