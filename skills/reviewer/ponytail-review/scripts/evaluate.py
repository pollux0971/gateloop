"""Deterministic content gate for the ponytail-review reviewer skill.

Verifies the SKILL.md states the over-engineering review discipline: the five
finding tags, the net-lines metric, the "Lean already. Ship." fallback, the two
GateLoop coordination bindings (recommendations defer to the contract / additive
gate; never flag the required minimum check as bloat), and the ABSENCE of host
cruft (this skill is injected into the reviewer prompt, not via host machinery).

evaluate(text=None) -> (ok: bool, errors: list[str]).
"""
from pathlib import Path


def _skill_md() -> str:
    return (Path(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")


TAGS = ["delete:", "stdlib:", "native:", "yagni:", "shrink:"]
REQUIRED = [
    "net: -",                       # the net-lines metric
    "Lean already. Ship.",          # the nothing-to-cut fallback
    "bounded by the contract",      # coordination 1: defer to contract/additive gate
    "additive gate",
    "Never flag the ponytail minimum",  # coordination 2: don't delete the required check
    "out of scope",                 # correctness/security/perf routed elsewhere
]
HOST_CRUFT = [
    "claude code",
    "statusline",
    "/ponytail",
    "mcp server",
    "sessionstart",
    "userpromptsubmit",
]


def evaluate(text=None):
    md = _skill_md() if text is None else text
    low = " ".join(md.lower().split())
    errors = []

    for tag in TAGS:
        if tag.lower() not in low:
            errors.append(f"missing finding tag: {tag!r}")
    for marker in REQUIRED:
        if marker.lower() not in low:
            errors.append(f"missing required marker: {marker!r}")
    for cruft in HOST_CRUFT:
        if cruft in low:
            errors.append(f"host cruft must be stripped: {cruft!r}")

    return (len(errors) == 0, errors)


if __name__ == "__main__":
    ok, errs = evaluate()
    print("ok" if ok else "FAIL")
    for e in errs:
        print(" -", e)
