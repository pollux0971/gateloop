# Promotion Runtime Workflow

The last trust-boundary crossing: turning a validated, checkpointed candidate into a
promoted change. **Always human-gated.** Policy: `../policies/PROMOTION_POLICY.md`.
Schema: `specs/promotion_policy.schema.json`.

```text
Checkpoint (validated, rollback notes present)
  → Promotion gate (human)
       requires: validation PASS record · rollback plan present · raw trace present ·
                 secret hygiene PASS · contract.promotion_allowed = true
  → human merge → human promotion → DONE
```

## Rules
- `workspace-apply passed` is **not** promotion — a candidate sits at
  `promotion_status: not_started` until a human approves.
- Promotion is **blocked** if: rollback plan missing · trace missing · secret-hygiene
  fail · `promotion_allowed=false`.
- No agent — including the Supervisor — may declare promotion complete.

See `../architecture/12_RUNTIME_ALGORITHM_RULES.md` §12, `../validation/05_PROMOTION_GATE_TESTS.md`.
