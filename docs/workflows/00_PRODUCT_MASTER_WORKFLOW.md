# Master Workflow

## 1. Idea intake

Raw idea is captured into `planning/IDEA-xxxx/00_idea_record.md`.

## 2. Planning Steward analysis

Planning Steward answers:

1. Is this greenfield, brownfield, patch, checkpoint, or research spike?
2. Which documents must exist before implementation?
3. Which stories can run in parallel?
4. When should integration happen?
5. What is the rollback model?
6. What context may be compacted, and what must remain raw?

## 3. Supervisor contract

Supervisor transforms the planning bundle into a story-level harness contract.

## 4. Developer proposal

Developer proposes a patch or implementation plan within the allowed write-set.

## 5. Workspace-only implementation

Changes are applied to a disposable workspace or story branch, not directly to stable.

## 6. Validation and debugging

Validators and tests run. If failed, Debugger receives failed logs and affected context.

## 7. Checkpoint and promotion

Promotion requires the promotion policy. A successful workspace result is not automatically a stable promotion.
