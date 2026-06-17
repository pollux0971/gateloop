# Runtime State Machine (product)

The **product** runtime lifecycle: the deterministic states the Orchestrator drives
when GateLoop runs a story on a project. The canonical state names are the ones in
`packages/harness-core` (the code is the source of truth). The exhaustive
"given state → next action" rows live in `configs/decision_matrix.yaml`; the per-story
control detail lives in `../agents/02_SUPERVISOR_AGENT.md`. Full rules:
`12_RUNTIME_ALGORITHM_RULES.md`.

> This is the product runtime machine. The **builder** `/goal` loop reuses it to build
> GateLoop (dogfooding) — see `../../../builder/claude-code/GOAL_LOOP_STATE_MACHINE.md`.

## Canonical lifecycle states (harness-core)
```text
IDEA_INBOX → PLANNING_BUNDLE → SUPERVISOR_CONTRACT → DEVELOPER_PATCH_PROPOSAL
  → DEVELOPER_PREFLIGHT → SPEC_CONFORMANCE_REVIEW → WORKSPACE_APPLY → VALIDATION → (fail) DEBUG_LOOP → VALIDATION
  → CHECKPOINT → HUMAN_GATE → PROMOTION_REVIEW → DONE
```
The Orchestrator owns the loop and advances these states; the Supervisor (LLM) is woken
only at decision points. Transitions out of `VALIDATION` and `DEBUG_LOOP` follow the
attempt-budget rules (§3) and the "repaired-but-still-failing" edges in the Supervisor
doc. `HUMAN_GATE` is entered on any trust-boundary crossing; `PROMOTION_REVIEW` is
always human.

## One reconciled vocabulary
Three name sets existed; they map as follows. Use the **canonical** column in code/docs;
the others are views.

| Canonical lifecycle (harness-core) | `/goal` loop step (decision_matrix.yaml) | Supervisor control sub-states (per story) |
| --- | --- | --- |
| IDEA_INBOX | resume *(intake)* | — |
| PLANNING_BUNDLE | *(planning)* | — |
| SUPERVISOR_CONTRACT | select, contract | READY_FOR_SUPERVISOR, SUPERVISOR_CONTRACT |
| DEVELOPER_PATCH_PROPOSAL | develop | DEVELOPER_TASK_PACKET, WAITING_FOR_DEVELOPER_RESULT |
| DEVELOPER_PREFLIGHT | develop *(preflight)* | — *(advisory self-check)* |
| SPEC_CONFORMANCE_REVIEW | develop *(gate)* | — *(hard gate before apply)* |
| WORKSPACE_APPLY | *(apply)* | WORKSPACE_APPLY_REQUEST |
| VALIDATION | validate | VALIDATION_REQUEST, VALIDATION_REVIEW |
| DEBUG_LOOP | debug | DEBUGGER_TASK_PACKET, WAITING_FOR_DEBUGGER_RESULT, REPAIR_APPLY_REQUEST |
| CHECKPOINT | checkpoint | CHECKPOINT_DRAFT |
| HUMAN_GATE | gate | HUMAN_GATE |
| PROMOTION_REVIEW | *(promotion)* | — *(human)* |
| DONE | done | DONE_OR_HUMAN_REVIEW |

## Ownership
The Orchestrator advances states and writes `tracker_state.json`. The Supervisor decides
*which* transition at its wake points but never advances the machine itself. The
Permission Gateway gates `WORKSPACE_APPLY`; the Validator alone resolves `VALIDATION`.
Keep this doc, `configs/decision_matrix.yaml`, and `packages/harness-core` in sync.

## Pre-apply reliability gates (DEVELOPER_PREFLIGHT, SPEC_CONFORMANCE_REVIEW)
Two Developer-side states sit between a proposal and the workspace apply. They raise
first-pass success without ever becoming the verdict:
- **DEVELOPER_PREFLIGHT** — advisory self-check (`packages/preflight-runner`): apply in a
  disposable workspace, run typecheck + affected tests, self-correct at most twice; a
  repeated failure signature ⇒ escalate (never loop). Passing here ≠ story passed.
- **SPEC_CONFORMANCE_REVIEW** — HARD gate (`validator-suite.specConformanceGate`): the
  proposal must be schema-valid, `changed_files` ⊆ write-set, acceptance machine-checkable,
  rollback present — else the Developer fixes it or escalates; it never reaches the Validator
  malformed.

When blocked/ambiguous at any point the agent emits a **structured escalation**
(`packages/agent-output`, `specs/escalation.schema.json`) instead of guessing — it does not
self-widen scope, delete tests, or hallucinate context. Only the Validator resolves
`VALIDATION`; only a human resolves `PROMOTION_REVIEW`.
