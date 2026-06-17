# Promotion Gate Tests

Assert promotion is correctly gated (see `../workflows/06_PROMOTION_RUNTIME_WORKFLOW.md`,
`../policies/PROMOTION_POLICY.md`).

| # | Case | Expected |
| --- | --- | --- |
| 1 | workspace-apply passed | `promotion_status = not_started` (apply ≠ promotion) |
| 2 | promotion without human approval | blocked |
| 3 | rollback plan missing | promotion blocked |
| 4 | raw trace missing | promotion blocked |
| 5 | secret-hygiene check failed | promotion blocked |
| 6 | `contract.promotion_allowed = false` | promotion blocked |
| 7 | all conditions met + human approves | merge → promote → DONE |
| 8 | agent attempts to declare promotion complete | rejected (human-only) |
