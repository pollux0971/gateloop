# Patch Proposal (contract)

What the **Developer** returns for a Task Packet: a single, reversible, typed
change plus the evidence the harness needs to apply and judge it. The Developer
**proposes**; the harness applies. Schema: `specs/patch_proposal.schema.json`.

## Producer / consumers
- **Produced by:** Developer (or Debugger, as a repair proposal).
- **Consumed by:** Permission Gateway (checks `changed_files` ⊆ contract write-set
  before apply), Workspace Manager (applies the diff in a disposable workspace),
  Validator (runs `validation_commands_run`), Supervisor (reviews).

## Fields
| Field | Meaning / rule |
| --- | --- |
| `proposal_id` | identity |
| `story_id`, `contract_id`, `contract_version` | the contract this answers (must match the issued version) |
| `summary` | one line: what changed and why |
| `change_type` | a GRASP operator: REBIND / INSERT_PREREQ / SUBSTITUTE / REWIRE / BYPASS / ADD — declares the kind of change |
| `changed_files` | every path touched — must be a subset of the contract's `allowed_write_set` |
| `patch_branch`, `patch_diff_path` | where the diff lives (workspace branch + file) |
| `postconditions_claimed` | what the change is asserted to achieve (claims, not proof) |
| `validation_commands_run` | commands the Developer ran locally (informational; the Validator re-runs authoritatively) |
| `failure_gene` | gene emitted if this was a repair |
| `proposed_at`, `status` | timestamp + lifecycle (proposed / applied / validated / rejected) |

## Invariants
`changed_files` outside the contract write-set ⇒ the Permission Gateway **denies the
apply** (it never lands) — this is not a validation failure. `postconditions_claimed`
is never accepted as proof; only the Validator's verdict counts. Every proposal must
be reversible (the contract's `rollback_notes` + the workspace branch make it so).
A proposal is additive-first: prefer adding over rewriting.
