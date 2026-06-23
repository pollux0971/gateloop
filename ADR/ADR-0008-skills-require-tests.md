# ADR-0008 — Skills are test-gated, versioned, iterable assets

## Status
Accepted · **Superseded by ADR-0013 (2026-06-23, STORY-TRUST.6)** — the test-gate is **RETIRED** under the operator-trust model: user skills install and run **unvalidated** (tests are an optional self-check, never a gate; no quarantine, no leakage-audit blocking registration). The Decision below is preserved as the historical record of the original (now-retired) policy and does **NOT** describe a current requirement. See `ADR/ADR-0013-no-sandbox-operator-trust.md`.

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
