# Debug Workflow & Automation (failure → triage → repair → learn)

The companion to `06_TEST_WORKFLOW_AND_AUTOMATION.md`. Where the test workflow
*proves* coordination, the debug workflow *reacts* to a failure: classify it,
repair the root cause within scope, escalate when stuck, and record what was
learned as a failure gene so the same failure is cheaper next time.

This is grounded in the harness you already built — `DEBUG_LOOP`, the
`failure-bank`, `debugger-runtime`, and the decision matrix — not a generic loop.
Where the research you uploaded informs a choice, it is cited inline.

> **Scope.** This documents two things that share the same machinery:
> (A) the **product** debug loop (how GateLoop repairs a failing story at
> runtime), and (B) the **build/test** debug loop (how Claude Code repairs a
> failing *test* in this repo via `/debug`). They use the same primitives; the
> difference is only what is being repaired.

---

## 1. The loop

```
VALIDATION (fail)
  → classify failure        classifyFailure(cmd, log)        → FailureType
  → build signature         buildFailureSignature(type, log) → matching_signal
  → retrieve prior genes    injectRelevant(bank, signal)     → known AVOIDs
  → route                   decideRepairRoute(...)           → debugger | developer | human
  → DEBUG_LOOP turn:
        emit ONE failure gene (invariant)  emitFailureGene({... avoid ≤40 words})
        apply a TYPED repair within scope  RepairOperator ∈ {REBIND, INSERT_PREREQ, SUBSTITUTE, REWIRE, BYPASS}
  → VALIDATION (re-run)
  → pass  → CHECKPOINT
  → fail  → same signature? → decideRepairRoute again (budget-bounded)
  → same signature ×2 OR budget exhausted → HUMAN_GATE
```

Every box is a real export in this repo. The loop is **bounded** at three places,
and a debug workflow that removes any of them is wrong:

- **attempt budget** (`enforceAttemptBudget`, `decision_matrix.budgets.attempt_budget_default = 3`) — total develop↔debug cycles per story.
- **same-signature threshold** (`repeated_failure_threshold = 2`) — the same `matching_signal` twice ⇒ escalate, never loop.
- **repair scope** (`allowed_repair_scope`) — a repair may only touch the scope the contract granted; widening it is a human contract revision, not a repair.

---

## 2. Classify before you repair

Never repair from the raw log. Reduce it to a type and a signature first, because
the signature is the dedup/retrieval key for everything downstream.

```ts
const type = classifyFailure(failedCommand, log);   // test|typecheck|lint|runtime|schema|integration
const sig  = buildFailureSignature(type, log);       // e.g. "test|add|expected|received|math"
```

The signature is what tells you whether you are making progress (signature
changed ⇒ different problem, hand back to Developer) or stuck (signature
unchanged ⇒ same root cause, stay with Debugger until the threshold).

> *Informed by GRASP (2604.17870):* it types failures into
> `{precondition, execution, postcondition, timeout}` and shows **typed repair
> recovers far better than global replanning** (84.2% vs 61.8% on precondition
> failures). Your `FailureType` taxonomy is the test-engineering analogue; the
> lesson is the same — *type the failure, then apply the matching repair
> operator, don't blindly replan.*

---

## 3. Repair within scope, with a typed operator

Pick the **smallest** repair operator that fits the failure, and keep it inside
`allowed_repair_scope`:

| Operator (`failure-bank.RepairOperator`) | Use when | Analogue in GRASP |
| --- | --- | --- |
| `REBIND` | right code, wrong inputs/arguments/config | REBIND |
| `INSERT_PREREQ` | a missing setup/precondition caused the failure | INSERTPREREQ |
| `SUBSTITUTE` | the approach is wrong; replace it, keep the interface | SUBSTITUTE |
| `REWIRE` | the wiring/order between parts is wrong | REWIRE |
| `BYPASS` | the step is unnecessary given current state | BYPASS |
| `none` | no safe local repair → escalate | (fallback) |

**Hard rule (this is the line the test suite exists to enforce, see
`02_AGENT_BOUNDARY_TESTS.md`):** repairing the *code under test* is allowed;
making the failure disappear by editing the test, deleting an assertion, widening
the write-set/repair-scope, or relaxing an invariant is **not a repair — it is
the exact violation we test for.** A green result obtained that way is a
regression; revert it.

---

## 4. Every debug turn emits exactly one failure gene

This is a runtime invariant (`system-invariants.assertFailureGenePerDebugTurn`)
and the mechanism by which the system *learns*. On each `DEBUG_LOOP` turn:

```ts
emitFailureGene({
  matching_signal: sig,
  summary: 'add() returned a-b instead of a+b',
  strategy: 'check the binary operator in the failing function',
  avoid: 'do not modify the test or acceptance criteria to force a pass',  // ≤ 40 words — enforced
  failure_type: type,
  repair_operator: 'SUBSTITUTE',
  story_id,
});
```

The gene is then banked (`bankGene`), consolidated (`consolidate`) so the bank
stays compact, and re-injected on future relevant failures (`injectRelevant` /
`formatForInjection`).

> *Informed by Gene/Evolver (2604.15097):* a gene's most valuable field is the
> compact **AVOID** warning — that paper found *"failure warnings only"*
> outperformed mixed strategy+failure bundles (+4.6 vs +2.0), and that
> accumulation must be **selective, not additive**. Your `avoid ≤ 40 words`
> limit and your `consolidate()` step are precisely those two findings in code.
> Keep them; do not let genes grow into documentation.

---

## 5. Escalate honestly

```ts
const route = decideRepairRoute({ sameRootCause, sameSignatureCount, debuggerAttempts, budget });
// 'debugger' : same root cause, within budget → another typed repair
// 'developer': signature changed → the patch created a *new* problem; rework, not repair
// 'human'    : same signature ×2 or budget exhausted → HUMAN_GATE
```

Escalation is not failure — it is the loop refusing to spin. When it routes to
`human`, write the signature, the two failing logs, and the genes emitted, then
stop. Only a human resolves `HUMAN_GATE` / `PROMOTION_REVIEW`.

> *Informed by GRASP's three-layer fault tolerance:* local repair → global
> replan → reactive fallback. Your ladder (debugger → developer → human) is the
> same escalating-severity idea; the `human` rung replaces "reactive fallback"
> because this system keeps a human at the trust boundary by design.

---

## 6. Automation — `/debug`

`.claude/commands/debug.md`. Triggered when a run (product or `/test`) lands in
`DEBUG_LOOP` with a failing verdict. One action per iteration, budget-bounded,
mirrors `/goal` and `/test`:

1. **CLASSIFY** the newest failure → type + signature; pull prior genes for that signature.
2. **REPAIR** with the smallest typed operator inside `allowed_repair_scope`; emit one gene.
3. **RE-VALIDATE**. Signature gone → checkpoint. Signature changed → route to Developer. Same signature → loop within budget.
4. **ESCALATE** on threshold/budget: write the debug session log + stop.

It records every turn to `builder/tracker/debug_session_log.md` (append-only) and
never rewrites it — it is the audit trail, the same way `decision_log.md` is for
`/goal`.

---

## 7. How test and debug fit together

```
/test   → RUN tests → on failure, hand the failing case to →  /debug
/debug  → classify → typed repair (code under test) → emit gene → re-validate
        → green → back to /test (re-run + extend coverage)
        → stuck → escalate, stop
```

`/test` owns *coverage and verification*; `/debug` owns *root-cause repair and
learning*. The failure-bank is the shared memory between them: genes emitted
while repairing make the next failure of the same signature faster to classify
and fix. Progress for both is tracked in `builder/tracker/` (see the two tracker
templates shipped with this bundle).
