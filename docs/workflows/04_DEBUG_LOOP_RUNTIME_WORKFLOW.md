# Debug Loop Runtime Workflow

Entered when the Validator returns FAIL (or a human-issue investigation is confirmed
reproducible). Governed by the Supervisor; bounded by the attempt budget.

```text
Validator FAIL (test/typecheck/lint/runtime/schema)
  → Supervisor issues Debugger Task Packet (failure_context + allowed_repair_scope)
  → Debugger: classify → root cause → minimal repair (GRASP operator) → emit failure_gene
  → [Permission Gateway] workspace-only apply (repair)
  → Validator re-run
       ├─ PASS → Checkpoint draft
       ├─ FAIL, same root, attempts<budget → back to Debugger
       ├─ FAIL, new failure            → back to Developer (rework)
       └─ attempts≥budget OR same signature ×2 → Human Gate
```

## Rules
- A repair stays within `allowed_repair_scope`; widening needs human-approved contract
  revision.
- Every attempt emits a `failure_gene`; `consolidated_count ≥ 2` ⇒ systemic → skip
  remaining budget and escalate (`configs/failure_bank.yaml`).
- Signature comparison is **within the run** in v0 (cross-run bank is a later layer).

See `../agents/04_DEBUGGER_AGENT.md`, `../contracts/FAILURE_GENE.md`,
`../architecture/12_RUNTIME_ALGORITHM_RULES.md` §3, §8.
