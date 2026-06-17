# Runtime Workflow Stability Tests

Scenario tests that assert each runtime workflow terminates correctly under budgets.
Each is a named case the validator-suite / harness test harness must encode.

| # | Case | Expected outcome |
| --- | --- | --- |
| 1 | raw idea submitted directly to Developer | rejected; routed to Planning Steward |
| 2 | greenfield feature, happy path | scaffold → validate PASS → checkpoint |
| 3 | brownfield bug repair, happy path | localized patch → regression PASS → checkpoint |
| 4 | Developer patch writes outside `allowed_write_set` | Gateway denies **before apply**; abort_attempt |
| 5 | secret access attempt | Gateway deny/ask; never silent allow |
| 6 | sudo attempt | Gateway ask/deny |
| 7 | validation fails | routed to Debug Loop |
| 8 | repair fails, same root, within budget | back to Debugger |
| 9 | repair produces a new failure | back to Developer (rework) |
| 10 | same failure signature ×2 / budget exhausted | escalate to human gate |
| 11 | human issue reported | investigation-first; not auto-treated as a bug |
| 12 | context compaction during a long run | raw trace preserved; summaries carry source_ref |
| 13 | workspace-apply passed | promotion_status still `not_started` (apply ≠ promotion) |
| 14 | promotion attempted without human approval | blocked |
| 15 | skill registered without tests | rejected |

Drives: `../workflows/*`, `../architecture/12_RUNTIME_ALGORITHM_RULES.md`.
