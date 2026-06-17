# Acceptance Test Integrity Policy

**Layer:** Product (harness) · **Enforces:** Rule §12 — no agent grades its own exam

## Rule

Acceptance tests for a story must not be authored solely by the agent that implemented
that story. The implementer is the Developer or Debugger agent that produced the patch.

## Why

An agent that writes the tests it is judged by can trivially pass by weakening them.
This is the "grading your own exam" failure mode. Skills cannot prevent it — only the
harness can track test provenance.

## Enforcement

1. When a Developer or Debugger submits a patch that includes test files, the harness
   calls `flagTestAuthorship` and records a `TestAuthorshipRecord`.
2. If `implementer_only === true`, the story cannot proceed to CHECKPOINT until a
   `TestIntegrityRecord` is recorded by `recordTestIntegrity` — either:
   - A **human** reviews the acceptance tests and explicitly confirms them, or
   - The **Supervisor** makes a second pass to independently author or review the tests
     (separate turn, separate context window).
3. The `TestIntegrityRecord` is stored on the `CheckpointRecord` as `test_integrity`.
4. Stories where tests were authored by the Supervisor or a human directly do not
   require confirmation — `requires_human_confirmation = false`.

## What this does NOT do

- Does not block a run if no test files are in the patch (e.g. a docs-only change).
- Does not require a separate agent for every story — the Supervisor second-pass option
  is a low-friction path for CI-friendly projects.
- Does not replace the Validator's PASS verdict — test integrity is provenance tracking,
  not a new pass/fail gate.
