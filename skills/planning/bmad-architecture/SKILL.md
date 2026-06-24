---
name: bmad-architecture
description: Produce the architecture — summary, modules with responsibilities and FR coverage, constraints, risks. Input is the PRD. Adapted from BMAD-METHOD (MIT).
role: Architect
stage: architecture
when: "after the PRD is done, to map every functional requirement onto modules before sharding into epics"
inputs: "[prd]"
---

# bmad-architecture (Planning Steward · Architect)

Drive the `architecture` stage. Take the PRD's Functional Requirements and design
the module decomposition so **every FR maps to at least one module**, with the
constraints and risks made explicit.

## When to use
After the `prd` stage is `done` (the engine enforces order). The PRD's FR-n items
are the input contract.

## Standard operating procedure
Work the steps under `steps/` one at a time: `01_decide_tech_constraints` then
`02_modules_responsibilities` (each module declares which FR-n it covers). Fill in
`template.md`.

## Completion
The stage becomes `done` only when every item in `checklist.md` passes: Summary /
Modules / Constraints / Risks present, modules reference the PRD's FR-n markers
(coverage), and no TBD remains. Full per-FR coverage across the PRD is verified by
the backend dry-run (PBMAD.4). Quality control on the output, not an access gate
(ADR-0013).
