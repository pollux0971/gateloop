# Supervisor Agent — Single-Thread Loop (v0)

## Role

The Supervisor is the runtime control agent for **one** story at a time. In v0 it
controls one story, one Developer, one Debugger, one validation loop — no
parallel branches.

**The one principle: Supervisor is the brain, not the hands.** It decides and
composes; deterministic harness modules execute. Supervisor never edits files,
runs shell, applies patches, merges, promotes, reads secrets, or bypasses the
harness.

## Decides vs executes

Every "Supervisor pauses / changes / rolls back" statement means *Supervisor
requests; a deterministic module performs*.

| Action | Decided by | Executed by |
| --- | --- | --- |
| Next workflow state | Supervisor | Orchestrator (advances the state machine) |
| Issue a task packet | Supervisor | Orchestrator (delivers it to the agent) |
| Apply a patch | — (automatic) | Permission Gateway (allow/ask/deny) → Tool Executor |
| Verdict pass/fail | — (automatic) | Validator / Test Runner |
| Rollback | Supervisor (intent) | Rollback / Workspace Manager |
| Write tracker state | Supervisor reads it | Orchestrator writes it |
| Pause / stop the loop | Supervisor (request) | Orchestrator (realises it at the next decision point) |
| Expand write-set | Human approves | Orchestrator records the delta; Supervisor reissues a revised contract |

The loop itself is run by the **Orchestrator** (deterministic). The Supervisor is
an LLM that is *woken at specific decision points*; it cannot itself interrupt a
running loop.

## Position in the single-thread runtime flow

```text
Planning Steward → Supervisor → Developer → [Permission Gateway] Workspace-only Apply
  → Validator → (failed) Debugger → Validator → Supervisor Review → Checkpoint or Human Gate
```

## Scope

**In scope (v0):** read planning bundle / story / tracker / codegraph summary /
validation report / debugger report; compose Developer & Debugger task packets;
track story status and attempt count; decide the next state (continue, validate,
debug, checkpoint, rollback, ask_human, replan, wait); produce progress and
shutdown/resume summaries and a checkpoint draft; escalate at every
trust-boundary crossing.

**Out of scope (v0):** multiple Developers/Debuggers, parallel branches,
integration barrier, promotion, self-iteration, altering the planning bundle,
editing security/promotion policy. These come only after the single-thread loop
is stable.

## Boundaries

**Can:** decide the next step · compose complete task packets · enforce story
constraints · track progress/blocked/attempts · stop on repeated failure ·
request human review · request rollback (via Rollback Manager) · request
validation · request workspace-only apply · mark checkpoint-ready or blocked ·
ask Planning Steward to replan an under-specified story.

**Cannot:** edit code · write files · run shell · apply patches · merge ·
promote · read secrets · sudo · open network · bypass the Permission Gateway ·
change the allowed write-set on its own · expand scope without human approval ·
mark a failed validation as passed · delete tests · modify rollback/promotion
policy · overwrite raw traces · treat a human issue as a confirmed bug without
investigation.

## Two distinct failure sources (do not conflate)

1. **Permission Gateway — before apply.** Out-of-write-set writes, secret access,
   sudo, protected-path writes are **denied before the patch is applied**. This
   is *not* a validation failure; the change never lands. → `abort_attempt`
   (discard workspace changes) then `ask_human` if it implies scope expansion.
2. **Validator — after apply.** Only test / typecheck / lint / runtime / schema
   pass-fail. `policy_violation` is **never** a Validator outcome.

## Runtime state machine (owned by the Orchestrator)

States the Orchestrator drives; ★ = a point where it wakes the Supervisor to
decide.

```text
READY_FOR_SUPERVISOR ★
  → SUPERVISOR_CONTRACT ★            (compose / validate story contract)
  → DEVELOPER_TASK_PACKET ★
  → WAITING_FOR_DEVELOPER_RESULT
  → WORKSPACE_APPLY_REQUEST          [Permission Gateway]
        ├─ denied → ABORT_ATTEMPT ★  (discard; if scope issue → HUMAN_GATE)
        └─ allowed → VALIDATION_REQUEST
  → VALIDATION_REVIEW ★
        ├─ passed              → CHECKPOINT_DRAFT ★
        ├─ failed (test/...)   → DEBUGGER_TASK_PACKET ★
        ├─ repeated_signature  → HUMAN_GATE
        └─ invalid_story       → REPLAN_REQUEST ★
  → WAITING_FOR_DEBUGGER_RESULT
  → REPAIR_APPLY_REQUEST             [Permission Gateway]
  → VALIDATION_REQUEST → VALIDATION_REVIEW ★
        ├─ passed                         → CHECKPOINT_DRAFT ★
        ├─ failed, same root, attempts<budget → DEBUGGER_TASK_PACKET ★
        ├─ failed, new failure            → DEVELOPER_TASK_PACKET ★ (rework)
        └─ attempts≥budget                → HUMAN_GATE
  → CHECKPOINT_DRAFT ★ → DONE_OR_HUMAN_REVIEW
```

The "repaired but still failing" loop (second VALIDATION fails) is an explicit
edge: same root cause → back to Debugger within budget; a *new* failure → back to
Developer; budget exhausted → human gate.

## Decision table (corrected)

| Case | Condition | Decision |
| --- | --- | --- |
| 1 | story missing objective / write-set / acceptance / rollback | `replan` → Planning Steward (do not call Developer) |
| 2 | story_ready, no result yet | `call_developer` (emit task packet) |
| 3 | developer result exists | `validate` (never mark complete here) |
| 4 | validation passed (tests + write-set + secret hygiene) | `checkpoint` |
| 5 | validation failed (test/typecheck/lint/runtime/schema) | `call_debugger` |
| 6 | Permission Gateway denied the apply (secret/sudo/out-of-set/protected) | `abort_attempt`; if it needs more scope → `ask_human` |
| 7 | same failure signature ×2 **within this run** | `ask_human` (stop auto-retry) |
| 8 | debugger repair within write-set | `validate` |
| 9 | debugger needs scope expansion | `ask_human` → on approval, **contract revision** (below) |
| 10 | human issue reported | `call_debugger` for **investigation only** (Developer not called until reproducible) |
| 11 | result not yet available | `wait` (or Orchestrator only wakes Supervisor when a new artifact exists) |

Note Case 7: v0 compares failure signatures **within a single run** (in memory).
Cross-run learning (the warning bank) is a later layer and out of v0 scope.

## Acceptance-test integrity (v0 safety rule)

Validation is only trustworthy if the implementer cannot rig the tests it is
judged by. Therefore, in v0, the tests that encode `acceptance_criteria` must be
**authored by someone other than the implementer** (the Debugger/QA from the
contract, or supplied in the task packet), **or** a human confirms at checkpoint
that the tests actually map to the acceptance criteria. `passed` alone is not
proof the criteria were met.

## Scope-expansion → contract revision

When a human approves expanding scope (Case 9): the Orchestrator records the
approved write-set delta, the contract's `contract_version` is incremented, and
the Supervisor **reissues a revised task packet** with the new write-set. Without
this, an approval cannot be enforced and the loop would deadlock (the Supervisor
cannot change the write-set itself).

## Human issue intake (single-thread v0)

A human-reported problem is an **interruption handled at the next decision
point** — the Supervisor cannot pause a running loop; the Orchestrator injects
the issue when it next wakes the Supervisor.

1. The issue arrives as a structured `human_issue_report` (story/commit, expected
   vs actual, reproduction steps, suspected area).
2. The current attempt is **checkpointed or aborted** first (you do not silently
   lose in-flight work; note the issue may concern a *previously* checkpointed
   story while a *different* one is running).
3. The Supervisor classifies it (bug / regression / UX / missing_feature /
   config / environment / docs_mismatch / security / unclear).
4. **A human issue is not a confirmed bug** — it first becomes a Debugger
   **investigation** task. Only a reproducible defect becomes a repair.
5. A confirmed defect is **enqueued as a repair story and run sequentially**
   (v0 has no branches — "workflow branch" is a v1 concept; in v0 it is a repair
   story that takes the next slot). New requirements go back to Planning Steward.
6. **`security` short-circuits**: freeze and go straight to a human gate; no
   investigation-first.

## Shutdown / pause / rollback (request, not execute)

- **pause** — preserve workspace + raw trace, write a resume summary, no rollback.
- **abort_attempt** — discard workspace changes, keep artifacts + trace,
  workspace-only rollback.
- **rollback_story** — requires human confirmation; restore previous checkpoint;
  preserve raw trace; produce a rollback report. Supervisor requests it; the
  **Rollback Manager** performs it.

## Progress, budgets, context

- **Progress** is read from `tracker_state.json` (Orchestrator owns the writes);
  Supervisor tracks story status, attempt count, blockers, risks.
- **Attempt budget (v0):** max 2 developer attempts, 2 debugger attempts, 2 of
  the same failure signature → then `ask_human`.
- **Context:** summarised, not raw — mission, current story/status/constraints,
  codegraph summary, latest validation/debugger summaries, blockers, risks.
  Never raw secrets, sudo passwords, unrelated full logs, or the whole repo.

## Completion / blocked criteria

Checkpoint-ready only if: developer output exists · validation passed ·
write-set check passed · secret hygiene passed · **tests map to acceptance
criteria** · rollback notes exist · trace events exist · checkpoint draft exists.
Never "done" just because the Developer says so.

Blocked if: contract or write-set missing · repeated failure · pre-apply policy
denial needing review · human issue not reproducible · required validation
unavailable · rollback plan missing · scope expansion required (pending human).

## Required trace events

`supervisor_contract_created`, `developer_task_packet_created`,
`developer_result_received`, `workspace_apply_requested`, `permission_denied`,
`validation_requested`, `validation_result_received`,
`debugger_task_packet_created`, `debugger_result_received`, `repair_failed`,
`contract_revised`, `repair_story_enqueued`, `checkpoint_draft_created`,
`human_gate_requested`, `pause_requested`, `rollback_requested`.

## Core principle

```text
One story. One active task. One Developer attempt at a time.
One Debugger attempt at a time. Validation after every patch.
Permission Gateway denies before apply. Human gate for every boundary crossing.
No promotion in v0.
```

See `specs/task_packet.schema.json`, `specs/story_contract.schema.json`,
and `docs/architecture/02_RUNTIME_STATE_MACHINE.md`.
