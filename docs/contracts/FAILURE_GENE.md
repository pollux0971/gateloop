# Failure Gene (contract)

A compact, control-oriented record of a failure, produced by the **Debugger** after
every repair attempt (success or failure) and injected before risky Developer turns.
Compact signals beat verbose retrieval. Schema: `specs/failure_gene.schema.json`.

## Producer / consumers
- **Produced by:** Debugger (one per repair attempt).
- **Consumed by:** the failure-bank (banks/dedups it) and the Context Manager
  (injects the `avoid` line before risky turns). See
  `../architecture/12_RUNTIME_ALGORITHM_RULES.md` §8 and `configs/failure_bank.yaml`.

## Fields
| Field | Meaning / rule |
| --- | --- |
| `id` | identity |
| `matching_signal` | pipe-delimited tokens; **any-token match** is the dedup + retrieval key |
| `summary` | what went wrong (human-readable) |
| `strategy` | what fixed it (or what to try) |
| `avoid` | **the operative payload**: ≤40 words, imperative; the *only* field injected into agent context |
| `failure_type` | test / typecheck / lint / runtime / schema / integration |
| `repair_operator` | the GRASP operator used (REBIND / INSERT_PREREQ / SUBSTITUTE / REWIRE / BYPASS) |
| `story_id`, `skill_id` | provenance |
| `severity` | low / medium / high |
| `version`, `created_at`, `resolved_at` | lifecycle metadata |
| `consolidated_count` | times this signal recurred; **≥ 2 ⇒ systemic** → skip remaining retry budget + escalate |
| `status` | active / resolved / quarantined |

## Invariants
Dedup is by `matching_signal` any-token match — never bank a duplicate; instead
increment `consolidated_count`. Only `avoid` is injected (≤5 genes/turn). `version`
keeps the bank append-only-ish (supersede, don't silently overwrite). A gene is
banked regardless of whether the repair succeeded — failures are learning signal.
