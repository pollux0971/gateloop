# Agent Architecture Refactor — Generation vs Assessment

**Status:** design baseline for EPIC-030 · **Layer:** product docs (agents)
**Supersedes parts of:** 00_AGENT_BOUNDARIES, 04_DEBUGGER_AGENT (context rules)

## What the live runs proved

Five paid live runs (2026-06-15) established one thing cleanly: **the harness is
100/100 (scripted baseline); every failure to deliver came from model cognition,
not mechanism.** Two specific failures point at one structural mistake:

1. **flash wrote a `todosCache` state-leak bug and could not debug it out** (61,
   no delivery) while pro converged (99.5, delivered). Same mechanism, one model
   tier apart = not-delivered → delivered.
2. **Multi-story integration collapsed**: the builder's own tests did not pass
   against its own implementation, and each story rewrote shared files, breaking
   previously-passing tests.

Failure #2 is the tell. It is not a "smarter model" problem — it is **the agent
that writes the code also defining what 'correct' means.** When the generating
mind authors its own acceptance bar, its blind spots contaminate both the
implementation and the standard that is supposed to catch it. No model, however
strong, should referee its own work.

## The principle of the refactor

> **Separate generation from assessment. Move the authority over "what is
> correct" out of any agent that generates code.**

Generation (writing code) can use a cheap model — it has downstream debug and
review to catch errors. Assessment (defining correctness, authoring acceptance
tests, judging completion) must be **structurally isolated from the generator**,
regardless of model tier.

## Two decisions this encodes (operator-confirmed)

1. **Acceptance tests are never written by the Developer.** They are authored in
   two layers: the Planning Steward defines *intent* at planning time (before any
   code exists, so there is nothing to over-fit to); a new **Assessor** fills in
   concrete acceptance tests and judges satisfaction, isolated from the Developer.
2. **The Debugger must not see the Developer's reasoning.** Each debug pass is a
   *fresh-context* diagnosis: it sees the broken result, the acceptance, and the
   diff — never "what the Developer was trying to do." Author intent contaminates
   diagnosis the same way it would contaminate a Reviewer (the anti-anchoring
   principle, now applied to the Debugger too).

   Note the rejected alternative: **merging develop+debug into one Developer was
   considered and rejected** — it would anchor debugging to the implementation
   memory completely, the opposite of what is wanted. Keep them separate; sever
   the Debugger's visibility into develop reasoning instead.

## The six agents after refactor

```
          Planning Steward   ── Human↔System; authors backlog + acceptance INTENT
                 │
              Supervisor      ── System↔Agents; routes, composes packets
        ┌────────┼────────┬──────────┐
   Developer  Debugger  Reviewer   Assessor
   (generate) (fresh    (global,   (judges completion;
              diagnosis) read-only) authors acceptance TESTS;
                                    isolated from Developer)
              └── deterministic harness ──┘
```

| Agent | Role | Trust class | Model need |
| --- | --- | --- | --- |
| Planning Steward | idea→backlog **+ acceptance intent per story** | source of the correctness standard | strong |
| Supervisor | route, compose task packets | coordination | mid |
| **Developer** | write code + implementation (NOT its own acceptance tests) | generator | cheap ok |
| **Debugger** | independent diagnosis + repair, **fresh context** | generator, de-anchored | cheap ok |
| **Reviewer** | global review; verify the *tests test the right thing* | assessor, cross-model | strong |
| **Assessor (new)** | author concrete acceptance tests; judge story satisfaction; isolated from Developer | assessor | strong |

### Assessor vs Reviewer (why both, not one)

They are both assessors but answer different questions and run at different times:

- **Assessor** — *"Does the implementation actually satisfy the requirement?"*
  Authors the concrete acceptance tests (from Planning's intent), runs them
  against the delivered code, judges pass/fail. Runs **at completion claim**.
- **Reviewer** — *"Is this change right for the whole project, and do the tests
  even test the right thing?"* Global consistency, regression surface, and a new
  duty: **validate that the acceptance tests are meaningful** (not vacuous, not
  over-fit). Runs **on failure / on cycle complete**.

The Assessor guards "did we meet the bar"; the Reviewer guards "is the bar itself
honest, and is the change globally sound." Collapsing them would put test
authorship and test auditing in the same agent — the very coupling we are
removing.

## Context: what each agent sees, and what it must never see

The core of the refactor. Assessment agents must be isolated from the
*generator's reasoning*, not just its output.

| Agent | GETS | NEVER GETS |
| --- | --- | --- |
| Planning Steward | requirements, brownfield as-is | (source; no upstream) |
| Supervisor | tracker, story state, acceptance | any agent's internal reasoning |
| Developer | task packet (goal + write-set + **acceptance tests**), relevant code | other stories' implementations; Reviewer/Assessor commentary |
| **Debugger** | failing output + acceptance + diff | **Developer's reasoning; prior debug passes' reasoning** (fresh each time) |
| Reviewer | failing/finished result + acceptance + diff + genes | **any implementation history** |
| **Assessor** | requirement intent + delivered result (code + tests) | **how the Developer/Debugger achieved it** (result only, not process) |

Two agents are explicitly **fresh-context** (no generator reasoning carried in):
the **Debugger** (per pass) and the **Assessor**. This is the anti-anchoring
invariant generalized from the Reviewer to every assessment role.

## Decoupling summary (what becomes independent)

```
authoring intent     (Planning)  ⊥  authoring tests   (Assessor)
writing code         (Developer) ⊥  judging code      (Assessor/Reviewer)
diagnosing failure   (Debugger)  ⊥  developer's intent (severed by fresh context)
local repair         (Debugger)  ⊥  global soundness  (Reviewer)
```

Four independent axes, each ownable by a differently-tiered model, each with its
own context allow-list. A cheap model can generate; assessment stays with a
strong, isolated model. This is what the live runs said the system needs.

## Boundary table additions (append to 00_AGENT_BOUNDARIES)

| Agent | MUST do | MUST NOT do |
| --- | --- | --- |
| **Developer** | write code + implementation within the write-set; produce additive, reversible patches | author its own acceptance tests · define what "correct" means · read other stories' implementations |
| **Debugger** | diagnose from broken result + acceptance + diff; minimal repair in write-set; emit gene | read the Developer's reasoning or prior debug reasoning · change goal/acceptance · widen scope |
| **Assessor** | author concrete acceptance tests from Planning intent; run them; judge satisfaction | see how the result was produced · write or modify product code · author its own pass verdict without running the tests |
