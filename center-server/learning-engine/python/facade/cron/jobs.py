"""Schedule references available to the skill curator."""
import transport


def referenced_skill_names() -> set[str]:
    return set(transport.call("schedule.call", {
        "name": "referenced_skill_names", "args": {},
    }))


def rewrite_skill_refs(*, consolidated=None, pruned=None) -> dict:
    raise PermissionError("Schedule skill references require a separate user change")
