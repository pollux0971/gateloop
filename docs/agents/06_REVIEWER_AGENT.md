# Reviewer Agent (the fifth agent)

**Status:** design baseline for EPIC-022 · **Layer:** product docs (agents)

## Why this agent exists

Observed in practice: when a story's test output is handed to a *fresh* model —
one that never read the implementation history — it produces improvement
directions the implementer and the Debugger could not see. The cause is
**anchoring**: the Developer and Debugger are biased by the path they already
took. A reviewer that is structurally denied that history sees the blind spots.

GateLoop should mechanize what a human currently does by hand ("paste the
test output into another AI"). That mechanism is the Reviewer.

## What the Reviewer is NOT

It is **not** the Supervisor wearing a second hat. Three reasons this separation
is load-bearing:

1. **Referee vs coach must stay separate.** The Supervisor is the referee — it
   routes develop/debug/escalate/checkpoint and decides escalation. If it also
   authored repair directions, a failed direction would have no neutral arbiter.
2. **The Supervisor is the most anchored agent** — it carries full run context.
   The Reviewer's entire value is the opposite: unanchored eyes. Giving the job
   to the Supervisor discards the active ingredient.
3. **Boundary rule.** The Supervisor must not enter the solution space
   (00_AGENT_BOUNDARIES). Authoring repair directions is solution-space work.

## Placement in the topology

The Reviewer is a **read-only advisory leaf**, parallel to Developer and
Debugger, never on a trust boundary:

```text
       Supervisor
      ╱     │     ╲
Developer Reviewer Debugger        ← Reviewer is read-only; no write-set
      ╲     │     ╱
   deterministic harness (gateway · validator · workspace · secret · orchestrator)
```

Star topology is preserved: the Reviewer never talks to the Debugger directly.
It writes a **diagnosis report** into the trace; the harness composes that
report into the Debugger's next context packet. **More eyes, not more mouths.**

## The anti-anchoring mechanism (the core design)

The Reviewer's value depends entirely on *not* being able to see what biased the
others. This is enforced **structurally**, not by prompt politeness:

| Reviewer GETS (read-only) | Reviewer is DENIED |
| --- | --- |
| the failing test output | the Developer's reasoning / chain-of-thought |
| the acceptance criteria | the Debugger's prior repair attempts' rationale |
| the final diff under review | the rejected approaches and their justifications |
| the matching failure genes | the implementer's framing of "what I was trying to do" |
| the story objective + write-set | the conversation history of develop/debug turns |

The context-manager's role-scoped loading for `role: reviewer` is exactly this
allowlist. If the Reviewer could read the implementation narrative, it would
anchor and the agent would be pointless — so the denial is a tested invariant
(`reviewer_context_excludes_implementation_history`), not a guideline.

**Cross-model by default.** model_routing may assign the Reviewer a *different*
provider/model than the Developer/Debugger. This is the mechanized form of "show
it to another AI" — decorrelating the reviewer's failure modes from the
implementer's. `model.reviewer_cross_model` (a setting) toggles it.

## The contract: diagnosis report

The Reviewer is a proposer like every other agent — it proposes a **diagnosis**,
not a patch. Output conforms to `specs/diagnosis_report.schema.json` and passes
the spec-conformance gate the same way a patch proposal does:

```yaml
diagnosis_report:
  failure_classification: <enum>          # logic | contract_mismatch | flaky | env | scope | unknown
  root_cause_hypotheses:                  # ranked, with confidence
    - { hypothesis: <text>, confidence: 0.0-1.0, evidence_refs: [...] }
  improvement_directions:                 # the ranked actionable list
    - { direction: <text>, rank: 1, expected_effect: <text>, touches: [files] }
  do_not_touch:                           # guardrails for the Debugger
    - <constraint>
  referenced_genes: [gene_ids]
  reviewer_model: <model_id>              # which brain produced this (for audit)
```

Hard rules: the Reviewer has **no write-set** (it writes nothing but the report
to the trace), cannot change the story goal or acceptance, and its directions
are **advisory** — the Debugger and the decision matrix decide what to act on.
A direction that requires scope expansion is flagged, never taken.

## Integration with the decision matrix

The Reviewer is an optional step on the `validate(fail) → debug` edge, gated by
a setting so it never inflates cost silently:

```text
validate(fail)
  → [if review.trigger fires] route_reviewer → diagnosis report into trace
  → route_debugger (now with ranked directions in context)
  → debugger acts on direction #1; on re-fail, #2; ...
```

- `review.trigger`: `on_second_failure` (default) | `on_every_failure` | `off`.
  Default: the first failure is a cheap Debugger retry with the failure gene;
  only the second failure earns a diagnosis.
- The ranked directions turn blind retries into a **bounded search tree** within
  the attempt budget — each retry tries a *different* direction, not the same
  guess again.
- This composes with two existing escalation tools, ordered cheapest-first:
  1. **swap information** — Reviewer directions (cheap).
  2. **swap the brain** — model escalation ladder (EPIC-018, expensive).
  3. **parallelize the search** — competitive debugging (017.4): k debuggers
     each take a *different* Reviewer direction → diversified bets, not
     duplicated ones.

## Failure bank upgrade: gene → remedy pairing

Today the failure bank stores failure *signatures*. With the Reviewer it can
store **which direction actually resolved which gene**. On the next matching
failure, the Reviewer pre-loads proven remedies. This is the difference between
a system that *remembers pain* and one that *learns cures*. (STORY-022.x.)

## New skills (Reviewer catalog, gated by 014.1)

| Skill | Codifies |
| --- | --- |
| test-output-interpretation | read failures: assertion vs error vs timeout vs flake |
| root-cause-hypothesis-ranking | order hypotheses by evidence and confidence |
| improvement-direction-authoring | actionable, ranked, scoped directions |
| what-not-to-change-guardrails | author do-not-touch constraints that prevent regressions |

## Boundary table row (append to 00_AGENT_BOUNDARIES)

| Agent | MUST do | MUST NOT do |
| --- | --- | --- |
| **Reviewer** | read failing output + acceptance + diff + genes; emit a ranked diagnosis report to the trace | author/apply a patch · hold a write-set · read implementation history or agent reasoning · change goal/acceptance · dispatch any agent · self-declare a fix |

## Local vs global (v28 addendum)

The Debugger is local by design (this story, this diff, this failure). The
Reviewer is global: cross-story consistency, acceptance-intent drift,
architecture conformance, regression surface, systemic gene recognition, churn
outlier re-scope recommendations, and per-cycle gate review in parallel mode.
Full division and diagnosis-report v2 fields:
`../architecture/14_DEV_CONSOLE_MODEL.md` §5.
