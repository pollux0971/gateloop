---
name: bmad-epics-stories
description: Shard the PRD + Architecture into epics and fine-grained stories — single-dev-session sized, no future dependency within an epic, Given/When/Then AC, every FR covered. Adapted from BMAD-METHOD (MIT).
role: SM
stage: epics
when: "after the PRD and Architecture are done, to produce the implementable backlog"
inputs: "[prd, architecture]"
---

# bmad-epics-stories (Planning Steward · Scrum Master)

Drive the `epics` stage. Turn the PRD's FRs and the Architecture's modules into
epics and **fine-grained stories**. The fine-grainedness rules are the heart of
this skill and live in `checklist.md`:

- each story is completable by a **single dev session** (declared `size: single-session`);
- **no story depends on a later story in the same epic** (declared `deps:`, backward-only);
- every story has **Given/When/Then** acceptance criteria;
- every PRD functional requirement is **covered by ≥1 story** (declared `covers: FR-n`).

## When to use
After both `prd` and `architecture` stages are `done` (engine-enforced order).

## Standard operating procedure
Work the steps under `steps/` one at a time: `01_design_epics_fr_coverage`,
`02_create_stories`, `03_validate_coverage`. Fill in `template.md`.

## Completion
The stage is `done` only when every checklist item passes. The exhaustive graph +
coverage assertions (per-story size, no-future-dep DAG, every-FR-covered) are run
by the backend dry-run (PBMAD.4) using the existing backlog generator. Quality
control on the output, not an access gate (ADR-0013).
