# Agent Boundaries

GateLoop has **two trust boundaries** and six agents (the Reviewer is a read-only advisory leaf added in EPIC-022; the **Assessor** is added in EPIC-030 to separate generation from assessment — see 06_REVIEWER_AGENT.md and 07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md). The boundaries are the
reason the system is safe; every agent is defined by what it may and may not cross.

```text
        Human
          │   ── Human↔System boundary ──  (Planning Steward owns this; authors acceptance INTENT)
     Planning Steward
          │   ── System↔Agents boundary ── (Supervisor owns this)
       Supervisor
        ╱    │    │     ╲
  Developer Debugger Reviewer Assessor
 (generate) (fresh   (global,  (authors acceptance TESTS;
            diagnosis) read-only) judges completion; isolated from Developer)
        ╲    │    │     ╱
   deterministic harness (gateway · validator · workspace · secret · orchestrator)
```

**EPIC-030 — separation of generation from assessment.** The authority over *what
is correct* is moved out of any agent that generates code. The Developer no longer
authors its own acceptance tests; the Planning Steward authors acceptance *intent*
(before code exists) and the new **Assessor** authors the concrete acceptance tests
and judges satisfaction, isolated from the Developer. The Debugger becomes
*fresh-context* — it never sees the Developer's reasoning.

## The boundaries
- **Human↔System** — only the **Planning Steward** turns human intent into a spec.
  Agents never take raw human instructions as work; new requirements go back here.
- **System↔Agents** — only the **Supervisor** turns a spec into contracts and
  dispatches agents. It is the single point that decides *what* runs.

## Per-agent boundary table
| Agent | MUST do | MUST NOT do |
| --- | --- | --- |
| **Planning Steward** | author PRD → architecture → epics/stories; classify intent; surface ambiguity; produce the planning bundle | produce a patch · run code · dispatch agents · touch the workspace |
| **Supervisor** | decide next state; compose Task Packets; track state; decide debug/checkpoint/rollback/human-gate; enforce the contract | edit code · run shell · apply/merge/promote · read secrets · sudo · change a write-set on its own · mark a fail as pass |
| **Developer** | write code + implementation within the write-set; produce additive, reversible patches (may *read* the acceptance tests in its packet) | author its own acceptance tests (EPIC-030) · define what "correct" means · read other stories' implementations · apply/merge/promote · widen scope · claim completion without the Validator |
| **Debugger** | diagnose from broken result + acceptance + diff; minimal repair in write-set; emit a failure gene; recommend route | read the Developer's reasoning or prior debug reasoning (fresh-context, EPIC-030) · change the story goal/acceptance · widen scope without approval · promote |
| **Reviewer** | read failing/finished result + acceptance + diff + genes; emit a ranked diagnosis report; verify the acceptance tests are meaningful (EPIC-030) | author/apply a patch · hold a write-set · read implementation history or agent reasoning · change goal/acceptance · dispatch any agent · self-declare a fix |
| **Assessor** (EPIC-030) | author concrete acceptance tests from Planning intent; run them against the delivered result; judge satisfaction (pass/fail + evidence) | see how the result was produced (Developer/Debugger reasoning) · write or modify product code · author its own pass verdict without running the tests · apply/merge/promote |

## Cross-cutting invariants (all agents)
Agents **propose**, the harness **applies**. No agent self-authorizes a permission,
self-expands its write-set, or self-declares completion. Raw secrets/sudo never
enter any agent's context. Boundary-crossing detection is **deterministic** (the
harness decides), not an agent flagging itself. Tested by
`../validation/02_AGENT_BOUNDARY_TESTS.md`.

## Reviewer registration

Registered in STORY-022.2 as EPIC-022's advisory leaf. Full boundary spec: `06_REVIEWER_AGENT.md`.

## Assessor registration

Registered in STORY-030.3 (`packages/assessor-runtime`) as EPIC-030's assessment
agent. It authors the concrete acceptance tests from the Planning-authored
`acceptance_intent` and judges story satisfaction, structurally isolated from the
Developer (result-only context, STORY-030.4) and cross-model by default
(STORY-030.8). The verdict conforms to `specs/assessment_report.schema.json`.
Full rationale: `07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md`.
