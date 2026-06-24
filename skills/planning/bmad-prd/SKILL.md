---
name: bmad-prd
description: Author the Product Requirements Document — problem, users, scope, itemized testable FR/NFR, success criteria. Adapted from BMAD-METHOD (MIT).
role: PM
stage: prd
when: "after the brief is done, to turn it into a testable PRD before architecture"
inputs: "[brief]"
---

# bmad-prd (Planning Steward · PM)

Drive the `prd` stage of the planning workflow. Turn the operator's brief into a
Product Requirements Document whose Functional Requirements are **itemized and
testable** and whose Non-Functional Requirements are explicit — so the
architecture stage has an unambiguous contract to map.

## When to use
After the `brief` stage is `done` (workflow order is enforced by the engine).
Never start the PRD before the brief exists.

## Standard operating procedure
Work the steps under `steps/` one at a time (the runtime surfaces them just-in-
time): `01_gather` (halts for the operator's problem / users / scope), then
`02_write_fr_nfr` (itemize FR-n and NFR-n). Fill in `template.md` section by
section.

## Completion
The stage becomes `done` only when every item in `checklist.md` passes under the
completion checker — every FR itemized + testable, no TBD placeholders left, and
users + scope captured. This is a quality control on the PRD output, not a gate
on the operator (ADR-0013).
