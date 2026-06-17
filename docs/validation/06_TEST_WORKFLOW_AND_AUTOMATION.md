# Test Workflow & Automation (global coordination + real-use)

How the per-component tests you already have become a **complete, automated,
Claude-Code-driven** test ladder that proves *global coordination* and *real
use* — not just local behavior.

> **The key reframe.** You did not skip the design of the coordination tests.
> You already wrote them — as specifications — in this folder:
>
> | Spec doc | What it specifies | Status |
> | --- | --- | --- |
> | `00_RUNTIME_WORKFLOW_STABILITY_TESTS.md` | 15 end-to-end workflow scenarios | **specified, mostly un-encoded** |
> | `01_RUNTIME_INVARIANTS.md` | 8 always-hold properties | **specified, un-encoded** |
> | `02_AGENT_BOUNDARY_TESTS.md` | 13 boundary-crossing denials | **specified, un-encoded** |
> | `03_SECURITY_SCENARIO_TESTS.md` | adversarial gateway cases | partially unit-covered (`permission-gateway`) |
> | `04_CONTEXT_COMPACTION_TESTS.md` | 10 context-manager cases | **specified, un-encoded** |
> | `05_PROMOTION_GATE_TESTS.md` | promotion gate cases | **specified, un-encoded** |
>
> The gap is not "what to test." It is: **these rows are markdown, not runnable
> tests.** The walking skeleton (`scripts/walking-skeleton.ts`) is the *one*
> coordination case already encoded (≈ scenario #2, happy path, single agent).
> This workflow turns every remaining row into an encoded, traceable, automated
> test.

---

## 1. The five-layer ladder

Tests already present are L1. Everything you are asking about is L3–L4 plus the
cross-cutting invariants. Each layer is a **gate**: the runner stops at the first
failing layer (fail-fast), because a broken unit makes a coordination failure
unreadable.

| Layer | Question it answers | Mechanism | Maps to |
| --- | --- | --- | --- |
| **L0 — Static / contract** | Do agent outputs match their schemas? Does it typecheck? | `tsc -b`; `validateDeveloperResponse` / `validateDebuggerResponse` / `validateEscalation` (`agent-output`) against `specs/*.schema.json` | — |
| **L1 — Unit** *(HAVE)* | Does each component behave in isolation? | per-package `*.test.ts`, per-skill `test_skill.py` | every `packages/*`, `skills/*` |
| **L2 — Seam / integration** *(partial)* | Do two adjacent components agree at their boundary? | proposal → `specConformanceGate` → `evaluateToolRequest` → `applyProposal` → `runValidation` | `03_SECURITY_*` (gateway seam) |
| **L3 — Coordination** *(the "全域協調" ask)* | Does the **orchestrator drive all four agents through the state machine correctly**, including failure loops, budgets, escalations, gates? | drive the loop with **scripted providers** (no LLM) + assert state transitions + invariants | `00_*` rows 1,4–11, `02_*` all, `04_*` all, `05_*` |
| **L4 — Scenario / real-use** *(the "實際使用" ask)* | Does a realistic story run end-to-end to the right terminal state with all artifacts and invariants intact? — and does the wiring survive a **real** model call? | full lifecycle on backlog-shaped stories (scripted) **+** a small opt-in **live-provider smoke** set | `00_*` rows 2,3; promotion in `05_*` |

**Cross-cutting (runs inside every L3/L4 case):** the 8 invariants from
`01_RUNTIME_INVARIANTS.md`, encoded once as assertions in
`tests/invariants/system-invariants.ts` and called at the end of every
coordination run. A violated invariant fails the run regardless of the scenario
verdict — exactly as the spec says ("a violated invariant halts the run").

---

## 2. The enabling mechanism: the scripted-provider seam

You cannot test "global coordination" by calling real models — it would be
non-deterministic, slow, costly, and forbidden by default (`CLAUDE.md`: *no real
provider API calls unless a story contract explicitly permits it*). You don't
need to. The harness already has the seam that makes deterministic full-loop
testing possible:

```ts
// model-gateway — the same API the walking skeleton uses
const providers = new ProviderRegistry();
providers.register(createScriptedProvider('scripted-developer', [
  { case_id: 'fix-add', match: { target_agent: 'developer', task_class: 'patch_generation', story_id: 'STORY-DEMO' }, output: developerPatch },
]));
providers.register(createScriptedProvider('scripted-debugger', [
  { case_id: 'triage-1', match: { target_agent: 'debugger',  task_class: 'failure_repair',   story_id: 'STORY-DEMO' }, output: repairPatch },
]));
const r = await callFirstValid(providers, [...], request);
```

Everything *except* the model is the real harness: real git workspaces, the real
permission gateway, the real spec-conformance gate, the real validator, the real
state-transition table. A scripted provider plays each agent's *brain*; the
deterministic harness around it is what you are actually testing. This is the
single most important idea in the workflow — **the agents are mocked, the
coordination is real.**

Each scenario in `00_*` becomes: *scripted agent outputs + asserted state path +
asserted invariants*. A failure-path scenario (validation fails → debug → repair
fails → escalate) is just a provider that returns a still-failing patch on the
first debug turn and a same-signature failure on the second, then asserting the
route lands on `human`.

---

## 3. Spec-to-test traceability (what makes it "complete")

"完整測試" means *every specified row is encoded and stays encoded*. The workflow
enforces this with a **coverage manifest** rather than trusting memory.

Every encoded test is tagged with the spec row it covers:

```ts
specCase('00#7', 'validation fails → routed to Debug Loop', async () => { ... });
specCase('01#4', 'validation-before-completion', async () => { ... });
specCase('02#11', 'Debugger deletes a test to force PASS → rejected', async () => { ... });
```

`scripts/test-all.ts` parses the `docs/validation/*.md` tables to build the set
of *specified* row IDs, parses the `specCase(...)` tags to build the set of
*encoded* row IDs, and reports the difference:

```
SPEC COVERAGE
  00_RUNTIME_WORKFLOW_STABILITY   13/15 encoded   (missing: 00#12, 00#14)
  01_RUNTIME_INVARIANTS            8/8  encoded
  02_AGENT_BOUNDARY                11/13 encoded   (missing: 02#3, 02#12)
  ...
  TOTAL                            49/57 encoded   (86%)
```

This number is the real definition of "done" for testing — not "the tests pass",
but "every specified case is encoded *and* passes." It's also the backlog the
`/test` command works from when you ask it to *extend* coverage.

---

## 4. The "real use" layer (L4) — and the one rule it must respect

Two sub-layers, because "real use" means two different risks:

**4a. Scenario / acceptance (scripted, always-on).** Full lifecycle
`IDEA_INBOX → … → CHECKPOINT/HUMAN_GATE/DONE` on backlog-shaped stories. Asserts
the terminal state, the produced artifacts (checkpoint record, validation
report, event-log chain), and all 8 invariants. This is `00_*` rows 2 & 3 done
properly, end to end, with every agent in the loop.

**4b. Live-provider smoke (opt-in, budgeted).** Exactly **one or two** trivial
stories run against a *real* model to catch wiring drift that scripted providers
can't (e.g. the real model returns a shape your union validator rejects). This is
the only place a real API call happens, so it is gated hard:

- Runs **only** when `CODEHARNESS_LIVE_SMOKE=1` *and* a key is present — never in
  default `test`, never in PR CI by default.
- Bounded by `attempt_budget` and a wall-clock timeout.
- Story contract must carry `permits: [real_api]` (honors the `CLAUDE.md` rule).
- Asserts shape + a single end-state, not exact text (models drift).

`pnpm test` and PR CI run L0–L4a. L4b runs nightly / pre-release / on demand.

---

## 5. Automation — making Claude Code run it autonomously

Two entry points, mirroring your existing `/goal` design so the build loop and
the test loop feel identical.

### 5a. `scripts/test-all.ts` — the layered runner (the engine)

One command, ordered gates, machine-readable report. `pnpm test:all`.

```
L0 static      → tsc -b + schema conformance
L1 unit        → vitest (packages/**, skills via pytest)
L2 seam        → vitest tests/seam/**
L3 coordination→ vitest tests/coordination/**  (+ invariants on each)
L4a scenario   → vitest tests/scenario/**       (+ invariants on each)
L4b live smoke → only if CODEHARNESS_LIVE_SMOKE=1
→ SPEC COVERAGE report → exit non-zero if any gate failed OR coverage regressed
```

Fail-fast across layers; within a layer, run all and report. Emits
`artifacts/test-report.json` (consumed by the `/test` command and CI).

### 5b. `/test` — the Claude Code command (the autonomy)

`.claude/commands/test.md`. Same shape as `/goal`: read state → take exactly one
action → update tracker → stop on a budget/stop condition. It does three jobs,
chosen by what the report says:

1. **RUN** — execute `test:all`, read `test-report.json`.
2. **TRIAGE & REPAIR** — for a failing test, classify it with the product's *own*
   debugger taxonomy (`classifyFailure` → `buildFailureSignature`), then repair
   the **code under test** (never the test, never by widening a write-set, never
   by deleting an assertion — those are boundary violations the suite itself
   forbids). Same-signature ×2 ⇒ stop and escalate, exactly like the runtime.
3. **EXTEND** — when all green, read the SPEC COVERAGE gap, pick the
   highest-priority un-encoded row, encode it as a `specCase(...)` using the
   patterns in `tests/coordination/lifecycle.coordination.test.ts`, re-run, and
   record the new coverage number.

Stop conditions (write tracker + print resume summary, never spin): coverage
target reached; per-run repair budget exhausted; same failure signature twice; a
human-gate / promotion case touched.

### 5c. CI + git hook

- **`package.json`**: replace `"ci"` with `tsc -b && tsx scripts/test-all.ts`
  (keeps the existing typecheck+vitest+pytest, adds the ladder + coverage gate).
- **GitHub Actions**: run `test:all` on PR (L0–L4a). Nightly job sets
  `CODEHARNESS_LIVE_SMOKE=1` for L4b. Fail the PR if coverage % drops below the
  committed baseline in `artifacts/test-report.json`.
- **pre-push hook** (optional): `tsx scripts/test-all.ts --until=L3` — fast
  enough to run locally, blocks pushing a broken coordination loop.

---

## 6. How to grow it (the loop you actually run)

```
ask Claude Code:  /test
  → RUN: all green, coverage 49/57
  → EXTEND: encode 00#12 (context compaction during a long run)
            using the coordination template + the context-manager seam
  → RE-RUN: 50/57
  → repeat until coverage target, then stop with a resume summary
```

You are never inventing test cases — they are already enumerated in
`docs/validation/*`. The command's job is to *encode* them faithfully and keep
them green. "Complete" = coverage manifest at 100% of specified rows, all
passing, invariants holding on every coordination/scenario run.

---

## 7. File map (what ships with this workflow)

```
gateloop/
  docs/validation/06_TEST_WORKFLOW_AND_AUTOMATION.md   ← this document
  tests/
    invariants/system-invariants.ts                    ← the 8 invariants as reusable assertions
    coordination/lifecycle.coordination.test.ts        ← L3 template: full develop↔debug↔escalate loop
    scenario/…                                          ← L4a, cloned from the template per 00_* row
    seam/…                                              ← L2, gateway/validator boundaries
  scripts/test-all.ts                                  ← the layered runner + coverage manifest
.claude/commands/test.md                               ← the /test autonomy command
```

Wiring note: the scaffold files are written against the **real** exports of
`harness-core`, `model-gateway`, `validator-suite`, `tool-executor`,
`workspace-manager`, `debugger-runtime`, and `agent-output` as they exist in
this workspace. Where an agent runtime is still a skeleton (e.g.
`producePatchProposal` returns a stub), the scripted provider supplies the output
the real agent will later produce — so the coordination test is valid now and
stays valid when the runtime is filled in.
