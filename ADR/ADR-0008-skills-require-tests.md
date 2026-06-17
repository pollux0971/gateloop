# ADR-0008 — Skills are test-gated, versioned, iterable assets

## Status
Accepted

## Context
Skills generated once and trusted forever are brittle and unverifiable, and they
drift as the codebase changes.

## Decision
Every skill package must ship `tests/`. A skill registers to the Skill Bank only
after its tests pass in a disposable workspace, it clears a fresh-run robustness
check, and it passes a leakage audit. Failing skills are iterated one change at
a time against the prior version under a bounded budget; exhaustion quarantines
the skill with a compact warning. Promotion to a stable skill is a human gate.
See docs/workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md.
