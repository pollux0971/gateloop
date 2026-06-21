"""Deterministic content gate for the ponytail-lazy developer skill.

A behavioral (prompt) skill is verified by checking that its SKILL.md actually
states the discipline it promises: the full lazy ladder, the two GateLoop
coordination bindings (so it does not fight the additive gate / contract), the
"when NOT to be lazy" carve-outs, and the ABSENCE of host-specific delivery cruft
(this skill is injected by composeSystemPrompt, not by any host's hooks/MCP).

evaluate(text=None) -> (ok: bool, errors: list[str]).
If text is None the sibling SKILL.md is read.
"""
from pathlib import Path


def _skill_md() -> str:
    return (Path(__file__).parents[1] / "SKILL.md").read_text(encoding="utf-8")


# Each ladder rung, identified by a stable substring that must appear.
LADDER_RUNGS = [
    "need to exist at all",   # 1 YAGNI
    "Standard library does it",  # 2 stdlib
    "Native platform feature",   # 3 native
    "already-installed dependency",  # 4 installed dep
    "Can it be one line",        # 5 one line
    "minimum code that works",   # 6 minimum
]

# The two ADR coordination edits — required so "lazy" never fights GateLoop's gates.
COORDINATION_MARKERS = [
    # (1) deletion bounded by the additive gate / contract
    "Never remove an existing exported",
    "additive gate",
    # (2) question via escalation, not silent under-building
    "escalation",
    "silently doing less",
]

# "When NOT to be lazy" carve-outs that must survive.
CARVEOUT_MARKERS = [
    "trust boundaries",
    "security",
    "Lazy code without its check",
]

# Host-specific delivery machinery that must NOT leak into a GateLoop skill
# (GateLoop injects via composeSystemPrompt; it has no slash commands, hooks, or MCP).
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
    # Normalize whitespace so a marker that wraps across markdown lines still matches.
    low = " ".join(md.lower().split())
    errors = []

    for rung in LADDER_RUNGS:
        if rung.lower() not in low:
            errors.append(f"missing ladder rung: {rung!r}")

    for marker in COORDINATION_MARKERS:
        if marker.lower() not in low:
            errors.append(f"missing coordination edit marker: {marker!r}")

    for marker in CARVEOUT_MARKERS:
        if marker.lower() not in low:
            errors.append(f"missing when-not-to-be-lazy carve-out: {marker!r}")

    for cruft in HOST_CRUFT:
        if cruft in low:
            errors.append(f"host cruft must be stripped: {cruft!r}")

    return (len(errors) == 0, errors)


if __name__ == "__main__":
    ok, errs = evaluate()
    print("ok" if ok else "FAIL")
    for e in errs:
        print(" -", e)
