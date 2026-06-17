# Skill Lifecycle: Automated Testing and Iteration

Skills are not one-off generations. In GateLoop a skill is a long-lived,
**tested, versioned, iterable** asset. The same rule that governs stories
governs skills: nothing is trusted without validator evidence, and the harness
— not the agent — decides whether a skill is good enough to keep.

This makes skills the portable unit of capability shared across Claude Code and
Codex: a skill that passes its tests is usable by either executor.

## Required layout

Every skill is a package (see `specs/skill_package.schema.json` and the
`skills/_TEMPLATE/` example):

```text
skills/<role>/<name>/
  SKILL.md        # interface + SOP + postconditions (a stable control surface)
  skill.json      # manifest: version, status, tests, provenance, depends_on
  scripts/        # implementation
  resources/      # static assets
  tests/          # REQUIRED unit tests — these gate registration
  .memory.md      # append-only, compact per-skill warnings/lessons
```

`tests/` is mandatory. A skill with no tests cannot be registered.

## Lifecycle state machine

```text
draft ──run tests──▶ (all pass?) ──yes──▶ robustness ──ok──▶ leakage audit ──pass──▶ registered
   ▲                     │ no                       │ below thresh        │ fail
   └────── refine ◀──────┘                          ▼                     ▼
        (one change,                            quarantined           quarantined
         re-test vs prior)
registered ──superseded──▶ deprecated      registered ──unused/always-fail──▶ pruned
```

Statuses live in `skill.json.status`: `draft` · `tested` · `registered` ·
`deprecated` · `quarantined`.

## Automated testing

Four checks, all run by the harness in a **disposable workspace**, never against
the live bank:

1. **Registration gate (unit tests).** All tests in `tests/` must pass. This is
   the same `mark_passed` evidence rule used for stories. Only then does the
   skill enter the Skill Bank.
2. **Regression suite.** On any skill change, re-run that skill's tests *and*
   the tests of skills that list it in `depends_on`. A change must not break
   dependents.
3. **Robustness check.** Re-run the skill's tests over N fresh workspaces
   (default 5). A skill can pass once yet be brittle because it baked in
   assumptions from the single trajectory that produced it; the fresh-run
   pass-rate exposes this. Below the threshold (default 0.8) the skill is
   `quarantined` rather than registered.
4. **Leakage / OOD audit.** Reject skills that hardcode expected outputs, branch
   on task ids, or read ground-truth files. Recorded in
   `skill.json.leakage_audit`.

The pure registration decision is `decideStatus()` in
`packages/skill-tester`; the harness wires it to the workspace and tool
executor.

## Iteration

When a skill fails its tests, fails in production (the Debugger encounters it),
or drops below the robustness threshold, it is **iterated** — not silently
retried:

1. **One change at a time.** Propose a single structural change and re-test it
   against the *previous* skill version. Bundling several edits hides which one
   helped or regressed; isolating one change makes the pass/fail signal causal.
2. **Keep the prior version.** Versions are bumped (`skill.json.version`); the
   last registered version is the rollback target.
3. **Bounded budget.** After `iterationBudget` refine attempts (default 3)
   without reaching the gate, the skill is `quarantined` and a compact warning
   is written — the loop does not grind forever.
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
- The **Validator / Test Runner** runs the four checks above.
- The **Orchestrator** gates registration. Registering a tested skill to the
  bank is workspace-first and counts as a checkpoint; it is cheap and frequent.
  Promoting a skill to a *stable production* skill still goes through the normal
  promotion policy and human gate — `/goal` never promotes a skill on its own.
- Skills are model-neutral artifacts, so a skill registered while running on one
  provider remains usable when an agent runs on another (see the Model Provider
  Gateway).

Decision-matrix rows for the skill lifecycle are in
`docs/architecture/02_RUNTIME_STATE_MACHINE.md` and `configs/decision_matrix.yaml`.
