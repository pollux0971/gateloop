# Idea Intake Algorithm

## Input

A raw idea, OSS repository link, bug report, or feature request.

## Output

A planning bundle under `planning/IDEA-xxxx-name/`.

## Classification

```text
if task creates new product/module from scratch -> greenfield
if task modifies existing repo behavior -> brownfield
if task fixes a bounded defect -> patch
if task freezes current status -> checkpoint
if task studies external OSS/research -> research_spike
```

## Generated planning files

- `00_idea_record.md`
- `01_classification.md`
- `02_required_documents.md`
- `03_epic_story_graph.md`
- `04_parallelism_plan.md`
- `05_integration_plan.md`
- `06_rollback_plan.md`
- `07_context_compaction_plan.md`
- `08_supervisor_contract_draft.md`
- `09_acceptance_checklist.md`

## Ready-for-Supervisor gate

A bundle is ready only if all required files exist and every story has:

- objective
- write-set
- dependencies
- parallelism class
- rollback requirement
- context impact
- validation requirement
