# STORY-SH.5 — Scale-Hardening Effectiveness (set ≠ effective)

SH.1-4 **wired** the four project-level mechanisms; SH.5 **proves they are effective** —
each with an explicit CONTRAST so it demonstrates behaviour ("more stories run without
diverging"), not wiring. All offline fixtures; `real_api_calls` **false** throughout;
zero cost. Test: `tests/sh5_effectiveness.test.ts` (9 tests, all green).

---

## VERIFY 1 — convergence is trend-based, not flat-12 (the key contrast)
- **Divergent fixture** (clobber 1→2→3 over iterations 10-12) → `assessConvergence` returns
  `diverging`; `decideAutoAdvance` (budget 80, iteration 12) stops at **`project_diverging`**
  with `diagnosis` = "cross-story clobber rising 1→2→3" — **NOT `budget_exceeded`**.
- **Converging fixture** (delivering, rework/clobber flat) at the SAME iteration 12, SAME
  budget → **advances** to STORY-P.13 (continues past 12).
- **CONTRAST proven:** the OLD flat-12 budget halts BOTH at iteration 12 (`budget_exceeded`);
  the new layered budget (`projectIterationBudget(20)=80`) + monitor lets the converging one
  continue and stops the diverging one with the signal. It looks at the **trend**, not the
  **count**.

## VERIFY 2 — forward contract LOCATED and ENFORCED (both)
- **Located:** story 3 registers `FooConfig`; `contractsFromDependencies(registry,
  ['STORY-3'])` → `['FooConfig']`; `composeForwardContractContext` (via codegraph
  `locateContracts`) puts the **live definition (`foo-config.ts`) + usage (`use-foo.ts`)**
  into story 18's `relevant_files`/`codegraph_summary`. Registry = what; codegraph = where now.
- **Enforced (the contrast):** a story-18 patch **redefining** `FooConfig` in a different file
  → `contractComplianceGate` **refuses** (1 violation, "import it instead"); an **import-only**
  patch consuming it → **passes** (0 violations). Located AND enforced — not just visible.

## VERIFY 3 — WIP bounded
- 15 parallel-safe stories → `computeSpawnPlan` puts all 15 in `parallel_batch` (uncapped
  would spawn 15); `applyWipCap(plan, 4)` → `parallel_batch.length === 4`,
  `sequential_queue.length === 11`, **nothing dropped**, overflow **deterministic**
  (`STORY-W.01..04` kept, rest queued in order).

## VERIFY 4 — cross-run cost accumulates + project budget stops/warns
- RUN 1 records $4 / 40k tokens, persists. RUN 2 **loads the cumulative** ($4 — cross-run) →
  `projectBudgetVerdict` `ok`; +$4.5 → $8.5/10 → **`warn`** (≥80%); +$2 → $10.5/10 →
  **`stop`** ("budget reached"). Cumulative is real across runs; over-budget really stops.

## VERIFY 5 — integration + guardrails untouched
- The four compose without conflict: a converging 20-story project under budget, WIP-bounded
  (batch 2 / 1 queued), contracts located — `decideAutoAdvance` advances, `projectBudgetVerdict`
  ok, WIP capped, no interference.
- **Agent guardrails UNTOUCHED:** the real `configs/policy.yaml` still has
  `real_api_calls.enabled: false`; the additive gate (`removedExistingBehavior`) still detects
  a removed export (intact, unchanged by SH.4's new gate); SH.4's compliance gate touches only
  contract symbols (an unrelated export → no false stop). The whole epic verified to leave
  `providerToolPolicy`/`confinement`/`providerConfinementGate`/`skill-tester`/`permission-gateway`
  unmodified; additive gate + `producePatchProposal` + `runGated` only gained additions.

## Validation
- `tests/sh5_effectiveness.test.ts`: 9 fixture proofs, all green. Full suite **1471 pass / 9
  skip**, typecheck 0. `real_api_calls=false`; zero cost; outer repo, not pushed.

## set ≠ effective — closed
Each mechanism is shown EFFECTIVE against a contrast, not merely wired: convergence stops a
divergent project (by signal) while passing a converging one past 12; forward contracts are
located AND redefinition-refused; WIP is bounded; cross-run cost accumulates and caps. The
mechanisms written in SH.1-4 are proven effective.

---

## EPIC-SH COMPLETE — and the three large-project prerequisites are ALL done
- **SH.1** persistent project cost ledger (reuse `BudgetLedger.initialSpentUsd` + `ProjectRunState` v2)
- **SH.2** WIP cap (reuse `computeSpawnPlan`; deterministic overflow)
- **SH.3** project convergence monitor (3 signals → converging/stalled/diverging; diagnose-not-count; replaces flat-12)
- **SH.4** forward type contracts × codegraph synergy × compliance gate (registry=what, codegraph=where, gate=enforce)
- **SH.5** effectiveness proven (this report)

ponytail-restraint held throughout: every mechanism is a **project-level layer reusing the
story-level mechanisms** (failure-bank, decideAutoAdvance, HandoffCard, additive gate,
codegraph, BudgetLedger, computeSpawnPlan), and **no agent guardrail was touched**.

### The three prerequisites for a 20+ story project — ALL COMPLETE
1. **Codegraph wiring** (EPIC-CW) — the context root: locate story-relevant code, per-story
   injection (Mode 1) + the `query_codegraph` tool (Mode 2).
2. **GateLoop + ponytail** (EPIC-UST + EPIC-GATE) — unified skill/tool system, ponytail landed
   (developer + reviewer), "strict on the agent, smooth for the user", frontend skill management
   with a server-enforced boundary.
3. **Scale hardening** (EPIC-SH) — project-level convergence / forward contracts / WIP cap /
   durable cost ledger.

GateLoop now has the machinery to **run a 20+ story project without diverging**. Recommended
next step (per the readiness report): a **~10-story step-up** to re-prove the foundation
between the 3-7 it has delivered and the 20+ target, before committing to the large project.
