# Story Contract (contract)

The enforceable work order the **Supervisor** issues for one story. It is the
single source of truth for what may change and what "done" means — the Permission
Gateway and Validator enforce **this**, never an agent's prose. Schema:
`specs/story_contract.schema.json`.

## Producer / consumers
- **Produced by:** Supervisor (from a Planning-Steward story + architecture).
- **Consumed by:** the Orchestrator (drives the loop), the Permission Gateway
  (`allowed_write_set` / `forbidden_actions` / `allowed_tools`), the Validator
  (`acceptance_criteria` / `validation_commands` / `required_validators`), and the
  Developer/Debugger (rendered into a Task Packet).

## Fields
| Field | Meaning / rule |
| --- | --- |
| `contract_id`, `contract_version` | identity; `contract_version` bumps on any scope revision (see §11 of `../architecture/12_RUNTIME_ALGORITHM_RULES.md`) |
| `story_id`, `epic_id` | backlog linkage |
| `task_class` | greenfield / brownfield / debug / research_spike — selects the workflow |
| `objective` | one testable sentence; if absent the Supervisor must `replan` |
| `pre_conditions` | what must hold before work starts |
| `depends_on` | story ids that must be `done` first (DAG edge) |
| `parallelism_class` | sequential / parallel_safe / barrier / exclusive — read by the scheduler (v1) |
| `allowed_write_set` | glob list; the **only** paths a patch may modify (Gateway-enforced) |
| `forbidden_actions` | explicit denials (e.g. read .env, sudo, real API) |
| `allowed_tools` | tools the agent may request |
| `acceptance_criteria` | the conditions a passing test set must encode (machine-checkable preferred) |
| `validation_commands` | exact commands the Validator runs |
| `required_validators` | which validators must be green for a PASS |
| `attempt_budget` | max developer / debugger / same-signature attempts |
| `human_gate_required_for` | boundary crossings needing approval |
| `rollback_notes` | how to reverse; required before promotion |
| `failure_gene_ids` | genes to inject before risky turns |
| `env_snapshot_ref` | the env baseline (default `artifacts/env_snapshot.json`) |
| `context_impact`, `estimated_complexity` | planning hints |
| `contract_issued_at` | timestamp |
| `promotion_allowed` | whether this story may be promoted at all |

## Invariants
A contract is *development-ready* only if it has `objective`, `allowed_write_set`,
`acceptance_criteria`, `validation_commands`, and `rollback_notes`; otherwise the
Supervisor returns it to Planning Steward. No actor may change `allowed_write_set`
without a human-approved contract revision (`contract_version++`). The contract,
not the Task Packet prose, is authoritative.
