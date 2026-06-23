# 26 — Scale Hardening (the project-level layer for 20+ story projects)

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

Status: **Proposed** (investigation/design only — nothing implemented; `real_api_calls`
stays `false`). Date: 2026-06-22. Author: builder investigation.

Companion: `LARGE_PROJECT_READINESS.md` (the gap source), `02_RUNTIME_STATE_MACHINE.md`,
`15_CONTEXT_INHERITANCE_AND_COMPACTION.md`, `06_CODEGRAPH_INTEGRATION.md`,
ADR-22 (codegraph wiring), ADR-25 (gate philosophy). Builds on EPIC-CW (codegraph wired,
done), EPIC-UST/GATE.

The readiness report named four BLOCKING gaps. **Codegraph wiring is now DONE (EPIC-CW)**
— so this is the *second* recommended epic: the **project-level layer**. The discipline
(ponytail / ADR-25): **the story-level mechanisms are solid and tested — reuse them;
build ONLY the project-level layer they lack.**

---

## 0. TL;DR — reuse-heavy, add only the project layer

| Gap | Story-level today (REUSE) | Project-level (the only new part) | Size |
|---|---|---|---|
| Loop / convergence | failure-bank `isSystemic` (same-signature, consolidated_count≥2); `decideAutoAdvance` (GATE.1) | a **ProjectConvergenceMonitor** (pure) → converging/stalled/diverging verdict; wired as a new stop in `decideAutoAdvance`; layered budget replaces flat 12 | **keystone** |
| Forward type contract | HandoffCard (facts-only); additive gate (blocks deleting an export); codegraph `lookupSymbol`/`locateRelevantCode` (real, EPIC-CW) | `produced_contracts` fact on the card + a **contract registry**, codegraph-located into the consumer's context, + a **conformance gate** (block redefinition/contradiction) | **biggest** |
| WIP cap | `computeSpawnPlan` (exclusive vs parallel_safe, overlap→serialize) | a `maxWip` cap: overflow spills deterministically to the sequential queue | **small** |
| Durable cost | `BudgetLedger` (USD, **takes `initialSpentUsd`**) + `TokenCapGuard` (per-run) | persist `cost_ledger` in `ProjectRunState` (schema v2); seed the ledger from cumulative; project ceiling | **small** |

Net: a **~5-story epic**. The new code is one pure monitor, one persistence field, one
cap, and one registry+gate. Everything else is wiring existing parts. **The
forward-contract ↔ codegraph synergy is the centrepiece** (registry = *what* was
produced; codegraph = *where it lives now*; conformance gate = *block contradiction*).

---

## 1. 調查 1 — Project-level loop / convergence (most critical)

### 1.1 The real problem (not "make 12 bigger")
Today the only project-wide stop is a flat `run_iteration_budget: 12` (`harness-core`
`enforceRunBudget`) — smaller than 20 stories, so it **halts mid-project instead of
diagnosing**. Story-level convergence is solid (failure-bank `isSystemic` / same-signature
stall / attempt budget). **The gap is a whole-project progress/divergence signal.**

### 1.2 Design — a pure ProjectConvergenceMonitor over the persisted history
Reuse `ProjectRunState` (already persisted across runs) as the history source. Compute a
verdict from three signals over a sliding window of the last K iterations:
- **delivery velocity** — stories reaching `done` per iteration. Positive/steady →
  progress; **zero over K iterations → `stalled`**.
- **rework rate** — escalations + Observe self-correction rounds + additive-gate
  rejections per iteration (all already recorded). **Rising across K → `diverging`**.
- **cross-story clobber** — `RegressionRegistry` re-runs of prior stories' acceptance
  failing (the *documented binding constraint*). **Growing → `diverging`**.

```
verdict = diverging   if rework-rising OR clobber-growing over K consecutive iters
        = stalled     if zero delivery over K iters
        = converging  otherwise   (delivery > 0, rework/clobber not rising)
```

### 1.3 Layered budget + wiring (reuse `decideAutoAdvance`)
- **Per-story:** attempt budget (exists, default 3).
- **Per-project:** replace flat 12 with a budget **scaled to story count** (e.g. `k·N`,
  generous) — but the *real* stop is the monitor, not the count. The count is only a
  backstop ceiling.
- **Wire:** `decideAutoAdvance` (GATE.1) is the project-loop decision point. Add two stop
  reasons — `project_stalled`, `project_diverging` — driven by the monitor's verdict.
  While `converging`, the loop continues past iteration 12 (up to the generous ceiling);
  on `diverging`/`stalled` it **stops and reports a diagnosis** (which signal tripped),
  not a bare count. This keeps GATE.1's existing stops (trust_boundary / epic_complete /
  budget / real_api_calls) intact.

### 1.4 Honest definition
"Converging" = positive delivery velocity AND non-rising rework AND no growing clobber
over the window. "Diverging, stop" = rework or clobber rising across K consecutive
iterations, or zero delivery over K. The monitor **diagnoses**; it never silently raises
a number.

## 2. 調查 2 — Forward type contract (+ the codegraph synergy)

### 2.1 Today
The cross-story unit is the **facts-only handoff card** (`delivered`/`touched_files`/
`acceptance`/`open_threads`/`trace_ref`); `assertHandoffCardFactsOnly` strips reasoning.
Story 3's `interface FooConfig` reaches story 18 as the string `'foo_config'` + a path —
story 18 must re-read disk; nothing surfaces or enforces the prior type.

### 2.2 Design — registry (fact) + codegraph (location) + gate (enforcement)
1. **Produced-interface fact on the card.** Add `produced_contracts: [{name, kind, path,
   signature_ref}]` — the type/API surface a story *exported*. This is a **fact, not
   reasoning** (it stays within the facts-only spirit — no how/why), so it doesn't
   reintroduce anchoring. The accumulation across stories is the **contract registry**
   (persisted in `ProjectRunState`).
2. **Codegraph synergy (the centrepiece — EPIC-CW ↔ scale).** When story 18 `depends_on`
   story 3, the Supervisor takes story 3's registered contract names and calls codegraph
   `lookupSymbol` / `locateRelevantCode` (real since EPIC-CW) to resolve the contract's
   **live definition + current usages**, and injects them into story 18's
   `relevant_files` / `codegraph_summary` (the sections EPIC-CW now fills). So: **the
   registry says *what* was produced; codegraph says *where it lives now* (authoritative,
   not a stale string).** The consumer gets the real type, located, in context.
3. **Conformance gate (block, not just see) — extends the additive gate.** The additive
   gate already blocks *deleting* an exported symbol. Add the dual: a patch that
   **redefines or contradicts a registered contract** (a duplicate definition of a
   registered name, or a signature change to it) is rejected pre-emit. Codegraph detects
   it (`symbol_lookup` finding two definitions; `impact` showing a signature change); the
   per-story typecheck (already in the regression gate) is the backstop. No bespoke
   type-checker — lean on codegraph + tsc.

### 2.3 Honest scope
Minimal = the `produced_contracts` fact + the registry + codegraph-backed injection + a
conformance check that flags duplicate/contradictory definitions. Not a full type system.

## 3. 調查 3 — WIP cap (small)
`computeSpawnPlan` emits `parallel_batch` with **no concurrency cap** — 15 parallel-safe
stories → 15 workspaces at once. Add a `maxWip` (param/config, default small, e.g.
`min(cores-2, configured)`); when `parallel_batch` exceeds it, the overflow spills
**deterministically** (sorted by story_id) into `sequential_queue` to run next round.
Pure, testable, minimal — no scheduler rewrite. (The O(n²) over-serialization and merge-
conflict gaps are NICE-TO-HAVE, out of scope here.)

## 4. 調查 4 — Durable project cost ledger (small)
`BudgetLedger` (USD, **already takes `initialSpentUsd`**) + `TokenCapGuard` (per-run) are
real but rebuilt-and-discarded each run; the tracker has no cost field. Add a
`cost_ledger` to `ProjectRunState` (bump schema_version → 2): `{cumulative_usd,
cumulative_tokens, project_budget_usd, project_token_cap, updated_at}`. Each run:
**load** → seed `new BudgetLedger(project_budget_usd, cumulative_usd)` → run → **persist**
the new cumulative. A project ceiling that warns near and stops at. This layers cleanly
**above** the router's per-call P−λ·cost and the per-run `TokenCapGuard` — three tiers:
per-call (router), per-run (TokenCapGuard), per-project (this). Pure reuse of
`initialSpentUsd` + `ProjectRunState` persistence.

## 5. 調查 5 — Verification (set ≠ effective), all offline/scripted
1. **Convergence:** a fixture project history that DIVERGES (rework rising / zero
   delivery) → assert the monitor returns `diverging`/`stalled` AND `decideAutoAdvance`
   stops with `project_diverging`/`project_stalled` (a diagnosis, not the flat-12 hard
   stop); a CONVERGING history → continues past iteration 12.
2. **Forward contract:** story 3 registers `FooConfig`; story 18's composed context
   includes the codegraph-located `FooConfig` definition + usages; a story-18 patch that
   **redefines** `FooConfig` → conformance gate **rejects**; one that imports it →
   passes.
3. **WIP:** 15 parallel-safe candidates → `parallel_batch.length ≤ maxWip`, the rest in
   `sequential_queue`, deterministic.
4. **Cost:** two sequential runs accumulate `cumulative_usd`/`cumulative_tokens` in
   `ProjectRunState`; crossing `project_budget_usd` → stop + warn.
All scripted (no model, no real API) — the same fixture/known-answer discipline as
EPIC-CW/UST/GATE.

## 6. Epic plan — EPIC-SH (ponytail-minimal, ~5 stories)

| Story | Scope | Reuse / new | Dep |
|---|---|---|---|
| **SH.1** | Durable project cost ledger: `ProjectRunState` schema v2 + `cost_ledger`; seed `BudgetLedger` from cumulative; project ceiling (warn/stop). | reuse `BudgetLedger.initialSpentUsd` + `ProjectRunState` persistence | — |
| **SH.2** | WIP cap on `computeSpawnPlan` (`maxWip` + deterministic overflow→queue). | reuse spawn-plan | — |
| **SH.3** | **Keystone:** `ProjectConvergenceMonitor` (pure verdict over persisted history) + wire `project_stalled`/`project_diverging` into `decideAutoAdvance`; layered budget replaces flat 12. | reuse decideAutoAdvance + failure-bank patterns; reads SH.1's persisted state | SH.1 |
| **SH.4** | **Biggest / synergy:** forward type-contract — `produced_contracts` card fact + registry; codegraph-located injection into the consumer's context; conformance gate (block redefinition/contradiction) extending the additive gate. | reuse HandoffCard + codegraph adapter (EPIC-CW) + additive gate | — (EPIC-CW done) |
| **SH.5** | Prove effectiveness (§5 items 1–4, offline). | the set≠effective barrier | SH.3, SH.4 |

Dependencies: SH.1 → SH.3; SH.4 independent (codegraph already wired); SH.5 after
SH.3+SH.4. SH.1/SH.2 are small self-contained reuse-extensions; SH.3 the keystone; SH.4
the largest. All scripted/offline — no story needs real spend (the convergence/contract/
WIP/cost proofs are all fixture-driven). ~5 stories, one epic.

## 7. Honest conclusion
- **How big?** One ~5-story epic — reuse-heavy. The four gaps are genuinely "the
  project-level layer on top of solid story-level mechanisms", not rebuilds.
- **What each reuses vs adds:**
  - Loop/convergence: reuse failure-bank patterns + `decideAutoAdvance`; **add** a pure
    project monitor + two stop reasons + a layered (not flat) budget.
  - Forward contract: reuse HandoffCard + additive gate + codegraph; **add** a
    `produced_contracts` fact + registry + a conformance gate.
  - WIP: reuse `computeSpawnPlan`; **add** a `maxWip` cap.
  - Cost: reuse `BudgetLedger.initialSpentUsd` + `ProjectRunState`; **add** a persisted
    `cost_ledger` + project ceiling.
- **Forward-contract ↔ codegraph synergy (the asked-for探問):** central and real. The
  registry records *what* each story produced (a fact on the handoff card); **codegraph
  resolves where that contract lives now** (definition + usages, authoritative) and feeds
  the consumer story's context; the conformance gate **blocks a later story from
  redefining/contradicting** it (codegraph detects the duplicate/signature drift, tsc
  backstops). EPIC-CW is the enabler — without real codegraph this would be a stale-string
  registry; with it, the forward contract is located and enforced against live code.
- **Then:** EPIC-SH closes the last BLOCKING gap. With all three prerequisites done
  (codegraph wired, GateLoop+ponytail, scale-hardened), re-prove on a ~10-story step-up
  before committing to a 20+ story product.
