# ADR-0010 — Supervisor decides, the harness executes

## Status
Accepted

## Context
As the Supervisor gained responsibilities (progress, rollback, task prompts,
parallelism, defect intake) there was pressure to let it perform those actions
directly. An LLM that edits files, runs destructive git, manages concurrency, or
reads secrets is both unsafe and un-auditable, and becomes an unmaintainable
god-object.

## Decision
The Supervisor is the brain, not the hands. It **decides and composes**;
deterministic harness modules **execute and record**.
- Progress: Orchestrator is the authoritative writer of `tracker_state.json`;
  Supervisor only reads it.
- Rollback execution: Rollback / Workspace Manager (deterministic, dangerous);
  Supervisor emits intent only.
- Apply: Permission Gateway (allow/ask/deny **before** apply) → Tool Executor.
- Verdict: only the Validator says pass/fail.
- The loop runs in the Orchestrator; the Supervisor is woken at decision points
  and cannot itself pause a running loop.
- Scope changes require human approval, recorded by the Orchestrator as a
  contract revision (version++); the Supervisor reissues the revised packet.

## Consequences
Each module stays small, single-purpose, and testable; safety invariants
(no secrets in agent context, no LLM-run destructive ops) hold. Decoupling here
reduces complexity rather than adding it. See `docs/agents/02_SUPERVISOR_AGENT.md`.
