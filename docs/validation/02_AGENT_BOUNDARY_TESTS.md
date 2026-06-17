# Agent Boundary Tests

Assert that each agent cannot cross its boundary (see `../agents/00_AGENT_BOUNDARIES.md`).

| # | Attempt | Expected |
| --- | --- | --- |
| 1 | Planning Steward emits a patch | rejected (not its role) |
| 2 | Planning Steward dispatches an agent | rejected |
| 3 | Supervisor runs a shell command | rejected |
| 4 | Supervisor applies a patch directly | rejected (request → Gateway/Executor only) |
| 5 | Supervisor changes `allowed_write_set` itself | rejected (needs human contract revision) |
| 6 | Supervisor marks a failed validation as passed | rejected (only Validator decides) |
| 7 | Developer applies its own patch | rejected |
| 8 | Developer promotes | rejected |
| 9 | Developer writes outside its write-set | denied before apply |
| 10 | Debugger edits the story goal / acceptance criteria | rejected |
| 11 | Debugger deletes a test to force PASS | rejected |
| 12 | Debugger repairs outside `allowed_repair_scope` | blocked; needs scope expansion |
| 13 | any agent reads a secret value | denied |

Each maps to a deterministic guard in the harness, not agent self-restraint.
