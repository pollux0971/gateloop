# Large-Project (20+ Story) Readiness Report

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

**Date:** 2026-06-21 · **Scope:** investigation only (zero cost, no spawn, no real API; `real_api_calls=false`).
**Question:** before committing to a brand-new 20+ story software project, does the harness foundation
support it? Specifically (1) is **codegraph** built enough to manage context for 20+ stories, and
(2) what does the harness still lack at that scale?

**Method:** read the real source (not memory), cross-checked by four independent investigators over
codegraph wiring, context+consistency, cross-story state/convergence/cost, and the empirical scale
evidence in `/data/python/codeharness_eval_output/`. Honest framing throughout: built is called built,
gaps are called gaps.

---

## TL;DR — the honest headline

**Do not run a 20+ story project on the current foundation yet.** The empirical ceiling is **5 stories
delivered end-to-end (under favourable conditions); 6 attempted, and that 6-story run failed to deliver
(19% test pass, no export).** A 20-story project is ~**3-4× beyond anything ever executed**, and the
single documented binding constraint — *multi-story build convergence (cross-story shared-file clobber
that compounds with each added story)* — is precisely the thing that gets worse as N grows.

The deterministic **data structures already scale** (the builder backlog holds 175 stories / 112 epics
with full `depends_on` DAGs). What was built and proven only for **3-7 story epics** is the **runtime
enforcement**: context relevance, forward contracts, project-level convergence, and project-level cost.
And **codegraph — the one capability a 20-story agent most needs (locate the code relevant to *this*
story) — is built-but-not-connected.**

---

## 1. CodeGraph — current state

**Verdict: built-but-NOT-connected (the seam is ready; nothing real is plugged in along any path an
agent actually runs).**

| Aspect | Finding |
|---|---|
| Adapter/interface | **Built.** `packages/codegraph-adapter/src/index.ts` (128 lines): clean `CodeGraphClient` interface + `lookupSymbol` / `computeImpactSet` / `filterToReadScope` / `summarizeForContext`. Read-only, injectable, tested. |
| Real client | **Exists but its backend does not.** `scripts/codegraph-client.ts` shells out to a real `@colbymchenry/codegraph` CLI — but `DEFAULT_BIN = /data/python/codegraph_engine/.../codegraph.js` is **absent**, no `.codegraph/` index exists, and the vendored copy the design cites (`external_references/.../codegraph/`) is **absent**. It implements only `operation:'impact'`; everything else returns empty. |
| Wired into the loop? | **No.** The only injection site is `scripts/gateloop-multistory-eval.ts` — the **eval harness, explicitly excluded build scaffolding**, not the product. No `packages/`/`apps/` path (planning-steward, supervisor, harness-core, provider-driver) constructs a real client. The agent-facing `query_codegraph` tool exists (`tool-interface`) but `provider-driver/confinement.ts:157` calls `providerToolSet()` with **no backends** → the tool is **never in the agent's tool surface**. |
| Locate-relevant-code op | **Dead.** `lookupSymbol` / `symbol_lookup` — the operation that would find "the code relevant to story N" — has **zero callers anywhere**. Only blast-radius `impact` is implemented, and only in the eval script. |
| `codegraph-query` skill | **Draft, untested, unregistered.** `skill.json`: `status:"draft"`, `leakage_audit:"unrun"`, `last_evaluation: 0/0`; declares `tests/test_skill.py` but the `tests/` dir **does not exist** → not registerable by the product's own rules. |
| Index lifecycle | **Not implemented.** Design (`06_CODEGRAPH_INTEGRATION.md`) says "build the index at `/goal` Step 0"; no such step exists; `.codegraph/` is never created. |

**For the 20+ story question:** the harness **cannot today** locate story-relevant code for an agent.
At small scale this is invisible (the codebase fits in context / the agent greps). As the generated
codebase grows over 20 stories, "rediscover the right files via my own tools every story" becomes
unreliable and expensive — and the tool meant to fix that is unwired. **Wiring codegraph is likely its
own epic** (build/vendor the engine + index lifecycle at Step 0 + give `query_codegraph` a real backend
+ implement `symbol_lookup`/per-story query + finish & register the skill).

---

## 2. Harness readiness at 20+ stories (the five inflection points)

### (a) Context management — **PARTIAL** (degrades to "carry refs + truncate" at scale)
- Selection is **by role, not by code relevance**: `buildRoleContextPacket` / `requiredContextSections`
  filter an already-assembled `ArtifactRef[]` by a hardcoded per-role name allow-list. `relevant_files`
  / `codegraph_summary` are **section *names*, with nothing that populates them from a code query**.
- **Codegraph is not plugged into per-story context** (context-manager doesn't import the adapter; the
  one product call is at *planning* time, defaulting to `NULL_CLIENT`).
- **"Compression" is char-truncation + sliding-window, not summarization.** The file's own note
  ("LLM-backed; not implemented until ROADMAP:phase-2", `context-manager:210`) is accurate — zero
  model-gateway imports; `summarizeTurn` = `.slice()`. This matches the design (`04_*.md`: "v0 does NOT
  do LLM summarization"). Pointer-safe compaction guarantees nothing is *unrecoverably* lost (every
  compacted section keeps a resolvable `trace_ref`), but the resident view is truncated and re-fetch is
  a manual choice, not automatic relevance re-injection.
- **Breaks at scale:** no relevance-based retrieval; truncation drops the tail of long turns; recall is
  pushed onto each agent re-reading the workspace from disk.

### (b) Long-range consistency — **MISSING-at-scale (by design)**
- The cross-story inheritance unit is the **facts-only handoff card**: `delivered: string[]`,
  `touched_files: string[]`, `acceptance`, `open_threads`, `trace_ref` (`harness-core:388-487`).
  `assertHandoffCardFactsOnly` + forbidden-keys actively **strip** anything richer; the design
  (`15_CONTEXT_INHERITANCE_AND_COMPACTION.md`) deliberately omits "how/reasoning" to avoid anchoring.
- Consequence: when story 3 defines `interface FooConfig`, story 18 receives the string `'foo_config'`
  + the file path — **not the type**. To honour it, story 18's agent must read disk; **no mechanism
  surfaces or enforces the prior type/API forward.**
- Backstops are narrow: exported-symbol-deletion guard (catches *deleting* a prior export, not
  *conforming* to it), opt-in `public_api_constraint.frozen_paths` (path freeze, planner-authored),
  write-set isolation, dependency ordering. "Shared types" is a **scaffold convention only** — no
  registry/validator forces later stories to import rather than redefine.
- **Breaks at 20+:** expect interface drift / re-definition / contradictory types across stories, caught
  only if it happens to delete an export or trip a cross-package typecheck (per-story authored, not
  guaranteed). This is the mechanism behind the documented integration failures.

### (c) Cross-story state / dependencies — **PARTIAL**
- **Representation: solid.** `depends_on` DAGs + `parallelism_class`; deterministic `selectNextStory`;
  dead-DAG escalation. The tracker already holds 175 stories with non-empty deps — 20+ nodes is well
  within the *data* range.
- **Scheduling: partial.** `runParallelScheduler` + `computeSpawnPlan` serialize write-set-overlapping
  stories (real contention guard); `detectHotFiles` downgrades hot-file stories to sequential. **But:**
  (1) **no WIP / concurrency cap** — if 15 stories are simultaneously parallel-safe it tries to spawn 15
  isolated workspaces at once; (2) overlap detection is **O(n²) coarse glob-*prefix* matching** → it
  over-serializes (false-positive conflicts) as write-sets grow, collapsing the parallelism it's meant
  to enable; (3) **merge-conflict output is ignored** (`mergeInOrder`'s conflicted-paths return is
  dropped).
- **Handoff: facts-only, no produced-interface contract** (same gap as (b)). Cross-story *regression*
  IS covered — `RegressionRegistry` re-runs all prior stories' acceptance tests each completion (real,
  but O(n²) total work across a project).

### (d) Convergence — **PARTIAL (story-level) / MISSING (project-level)**
- **Story / pattern level: solid + tested.** Same-signature stall escalates before the attempt budget
  is even spent; the failure-bank's systemic-pattern rule (`consolidated_count >= 2 → isSystemic →
  human gate`) catches a failure mode recurring *across* stories; attempt budget (default 3) enforced.
- **Project level: absent.** There is **no whole-project progress / divergence / stall metric** (grep
  for `converg|diverg|stall|thrash|progress` in the goal-loop doc returns nothing). The only
  project-wide stop is a **flat `run_iteration_budget: 12`** — a hard iteration cap, *smaller than 20
  stories*, that would **halt the project mid-way rather than diagnose convergence**. A project slowly
  oscillating (each story passing but the whole thing churning) has no detector.

### (e) Cost accumulation — **PARTIAL (per-run) / MISSING (project-wide)**
- **Per-run: enforced.** `BudgetLedger` (cumulative USD ceiling) + `TokenCapGuard` (per-run token kill
  switch, default 1.5M) + per-delegation caps are all real — but every ledger is **constructed fresh at
  the start of one eval run and discarded** at the end.
- **Router P−λ·cost: real but local** — optimizes each routing decision in isolation (a measured −34.6%
  builder-cost win), with **no project-budget awareness** (never sees cumulative spend).
- **Durable project budget: missing.** The tracker (`tracker_state.json`) has **no structured cost/token
  field** — `cost`/`usd`/`token` appear only in prose narratives. Across a 20-story project spread over
  many `/goal` runs, **aggregate spend is not tracked or capped anywhere.**

---

## 3. Gap list + priority

### BLOCKING — won't run / will crash a 20-story project as-is
1. **Project-level loop budget + convergence monitor.** The flat `run_iteration_budget: 12` halts a
   20-story run mid-project (cheapest failure to hit). Raising the number is trivial; the real need is a
   *convergence/progress* signal (stories-delivered-per-iteration, divergence/thrash detector) so the
   loop knows whether to continue, escalate, or stop — not just count to 12.
2. **Multi-story build convergence hardened past "catch & block."** This is the *documented binding
   constraint*. Today the win is "no false green" — clobbering work is caught and **blocked** (good),
   but that means at high N most later stories get blocked/escalated → **no delivery** (the ms_mini
   6-story outcome: 19% pass). Needs to move from *catch* to *converge & deliver*: stronger pre-apply
   Observe, contract-aware regression, decomposition that minimizes cross-story coupling.
3. **Codegraph wired for real** (locate story-relevant code). Without it, context recall over a growing
   codebase has no relevance mechanism. Likely its own epic (engine/index at Step 0 + tool backend +
   `symbol_lookup` + register the skill).
4. **Forward type/interface contract propagation.** Without it, 20 stories with shared APIs drift and
   contradict — the root of the integration failures. Needs a produced-interface handoff or a
   shared-types registry that later stories are structurally bound to (without re-introducing reasoning
   anchoring).

### NICE-TO-HAVE — will run but will hurt
5. **WIP / concurrency cap** on the parallel scheduler (don't spawn 15 workspaces at once).
6. **Durable project cost/token ledger** persisted in the tracker (cross-run budget cap + monitoring).
7. **Real LLM summarization** (replace truncation; the deferred phase-2).
8. **Merge-conflict resolution** in the scheduler (currently the conflict output is ignored).
9. **Finer write-set overlap** detection (avoid O(n²) prefix over-serialization).

---

## 4. Where it crashes first (if you run 20 stories today, unchanged)

1. **Iteration cap (≈ iteration 12).** The project halts before finishing — a hard stop, not even a
   convergence failure. Most visible, cheapest to hit.
2. **Then — the real wall — multi-story build convergence.** Even with a bigger budget: later stories
   regress earlier ones (cross-story clobber "compounds"), the harness correctly **blocks** them (no
   false green), and with no forward type-contract and no codegraph to locate the right code, more
   stories stall/escalate than ship. Outcome resembles the 6-story `ms_mini` run (19% pass, no export),
   worse at 20.
3. **Compounding it: context recall.** As the codebase grows, the developer agent — with role-scoped
   (not code-relevant) context, truncation-based compaction, and no runtime codegraph — increasingly
   edits the wrong place → more clobber → faster divergence.
4. **Silent at first, costly later: aggregate spend.** Each run's budget resets; a multi-run 20-story
   project has no aggregate cap.

---

## 5. Honest conclusion

**As-is, the harness cannot run a 20+ story project to delivery.** It is genuinely strong where it was
exercised — 5-story delivery under favourable decomposition, *zero false greens*, solid DAG/contention
representation, real per-run budgets, tested story-level convergence. But every "missing-at-scale"
finding (no runtime codegraph, no forward contracts, no project convergence monitor, no project budget,
truncation-not-summarization) shares one cause: **the runtime was built and proven for 3-7 story epics,
while 20+ stories is a qualitative jump that exposes exactly the cross-story dimensions that small epics
never stressed.**

**Recommendation:** treat "large-project readiness" as its own work *before* picking a 20-story product,
sequenced by the BLOCKING list — most naturally **two epics**: (1) a **codegraph-wiring epic** (engine +
index lifecycle + tool backend + per-story query + skill registration), and (2) a **scale-hardening
epic** (project-level loop/convergence budget + forward type-contract propagation + WIP cap + durable
project cost ledger). Then choose the product and design the 20+ story backlog on a foundation that has
been made — and ideally re-proven on a ~10-story step-up — to carry it. Do not jump straight to 20.

*One-line bottom line: the backlog format already holds 175 stories, but the harness has only ever
delivered 5 in one run — close the four BLOCKING gaps (loop/convergence budget, build-convergence,
codegraph wiring, forward contracts) before attempting 20.*
