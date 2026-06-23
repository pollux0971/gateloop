# Skill Lifecycle: Optional Self-Check and Iteration

Skills are long-lived, versioned, iterable assets. **ADR-0013 (operator-trust)
retires the ADR-0008 test-gate**: a skill the operator adds installs and runs
**unvalidated** — registration requires no tests, no quarantine, and no
leakage-audit. Testing a skill is now an **optional self-check** the operator
may run; it is never a gate. The operator trusts their own skills, the same
risk level as running any local AI coding tool (Claude Code / Cursor / aider)
with auto-run. This doc states exactly what now happens and claims no validation
that no longer occurs (leave no phantom defense).

The testing machinery below is **kept** because it is still a useful quality
signal — but read it as "the optional checks the operator can run", not "the
gate a skill must clear". Skills remain the portable unit of capability shared
across Claude Code and Codex.

## Required layout

Every skill is a package (see `specs/skill_package.schema.json` and the
`skills/_TEMPLATE/` example):

```text
skills/<role>/<name>/
  SKILL.md        # interface + SOP + postconditions (a stable control surface)
  skill.json      # manifest: version, status, tests, provenance, depends_on
  scripts/        # implementation
  resources/      # static assets
  tests/          # OPTIONAL unit tests — an operator self-check, NOT a registration gate
  .memory.md      # append-only, compact per-skill warnings/lessons
```

`tests/` is optional under ADR-0013. A skill with no tests still registers and
runs (unvalidated, operator-trust); shipping tests just lets the operator run
the optional self-check.

## Lifecycle state machine (operator-trust)

Registration is direct — the operator adds a skill and it is `registered`,
unvalidated. The optional self-check (tests → robustness → leakage) may be run
*alongside* a registered skill to inform the operator, but it does **not** gate
the transition and never moves a skill out of `registered`:

```text
draft ──operator adds──▶ registered            (unvalidated; no gate)
                            │
                            └── optional self-check (run tests / robustness / leakage)
                                  → advisory report only; the operator decides what to do
registered ──superseded──▶ deprecated
registered ──unused──▶ pruned
```

Statuses live in `skill.json.status`: `draft` · `registered` · `deprecated`.
`needs_tests` / `quarantined` remain valid values for an operator who *chooses*
to track self-check state, but the harness never forces a skill into them.

## Optional self-check (not a gate)

Four checks the operator MAY run in a **disposable workspace**. None of them
gates registration — a skill is already registered and runnable. They produce an
advisory report; the operator decides whether to act on it.

1. **Unit tests.** Run the tests in `tests/` (if any). A useful signal that the
   skill does what it claims — but a failing or absent suite does **not** block
   registration (ADR-0013 operator-trust).
2. **Regression suite.** On a skill change, optionally re-run that skill's tests
   *and* the tests of skills that list it in `depends_on`, to spot a change that
   breaks dependents.
3. **Robustness check.** Optionally re-run over N fresh workspaces (default 5) to
   expose brittleness baked in from the single trajectory that produced the skill.
   A low fresh-run pass-rate is advisory; it no longer auto-`quarantine`s.
4. **Leakage / OOD audit.** Flag skills that hardcode expected outputs, branch on
   task ids, or read ground-truth files. Recorded in `skill.json.leakage_audit`
   as information — it does not block registration.

The self-check helper `decideStatus()` lives in `packages/skill-tester`; it is
KEPT as an optional tool. The registration decision itself is
`canRegisterSkill()` in `packages/skill-runtime`, which permits unconditionally
under operator-trust.

## Iteration (optional, operator-driven)

If the operator runs the self-check and a skill fails its tests, fails in
production (the Debugger encounters it), or looks brittle, the operator MAY
**iterate** it — this is a quality workflow the operator chooses, not a gate the
skill is forced through:

1. **One change at a time.** Propose a single structural change and re-test it
   against the *previous* skill version. Bundling several edits hides which one
   helped or regressed; isolating one change makes the pass/fail signal causal.
2. **Keep the prior version.** Versions are bumped (`skill.json.version`); the
   last registered version is the rollback target.
3. **Bounded budget.** If the operator iterates, `iterationBudget` (default 3)
   keeps the optional loop from grinding forever; the skill stays registered and
   runnable throughout (the operator may mark it `quarantined` to track it, but
   nothing forces that).
4. **Distil failures into compact warnings.** Each iteration appends one short
   `AVOID:`/`DO:` block to `.memory.md`, keyed by a failure signature recorded
   in `failure_signatures`. Warnings are consolidated, not accumulated — the
   memory file stays small and is surfaced alongside `SKILL.md` on the next
   load. This mirrors how the Debugger's failure notes are kept compact.

## Management

- **Merge** near-duplicate skills into one more general skill (dedupe coverage).
- **Prune** skills that stay unused or always fail.
- **Deprecate** skills superseded by a newer one; keep them resolvable for
  rollback until safe to remove.
- **Typed edges.** `depends_on` (prerequisite) and `enhances` (improvement) let
  the loader retrieve skills in dependency order rather than as an unordered
  top-k list.

## Who does what, and how it plugs into `/goal`

- The **Developer** (acting as skill curator) proposes a skill package when it
  notices a reusable pattern, as part of a patch proposal — never as a side
  effect that skips review.
- The **Validator / Test Runner** runs the optional self-check above *if asked*;
  it no longer gates registration.
- The **Orchestrator** registers the skill directly (operator-trust) — it does
  **not** gate on tests. Registering is workspace-first and counts as a
  checkpoint; it is cheap and frequent. Promoting the harness/skill to a *stable
  production* branch still goes through the normal promotion policy and human
  gate — `/goal` never promotes on its own. (That promotion gate is a real
  boundary crossing, separate from the retired skill test-gate.)
- Skills are model-neutral artifacts, so a skill registered while running on one
  provider remains usable when an agent runs on another (see the Model Provider
  Gateway).

Decision-matrix rows for the skill lifecycle are in
`docs/architecture/02_RUNTIME_STATE_MACHINE.md` and `configs/decision_matrix.yaml`.
