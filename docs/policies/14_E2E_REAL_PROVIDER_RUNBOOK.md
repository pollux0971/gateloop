# Real-Provider E2E Runbook (STORY-013.2)

**Audience:** human operator · **Default:** deterministic, no network, CI-safe

The script `scripts/e2e-real-provider.ts` proves the end-to-end project-generation
path can be driven by a **real** LLM provider — gated, budgeted, and never run in CI.

## What it proves

Every run (including the default deterministic one) asserts three invariants:

1. **runs_only_with_real_api_calls_enabled** — the real path is reachable only when
   the `real_api_calls` gate is open *and* the operator opts in. The gate alone, or
   the opt-in alone, is not enough.
2. **budget_guard_active_throughout** — every model call is wrapped by `BudgetGuard`;
   calls within budget succeed, the over-budget call is blocked with a clear reason.
3. **artifact_quality_bar_met** — the generated artifact passes its quality bar (test).

## Default run (safe, deterministic)

```bash
node --experimental-strip-types gateloop/scripts/e2e-real-provider.ts
```

No network, no secret. The real provider is skipped with a clear message. This is the
form used by the story's validation command and by CI.

## Real run (manual, gated)

All four conditions must hold, or the script stays deterministic:

1. `configs/policy.yaml` → `real_api_calls.enabled: true` (and `kill_switch: false`) — see
   `13_REAL_API_ENABLEMENT_RUNBOOK.md` (011.4). This is a human gate.
2. `E2E_REAL=1` — explicit opt-in.
3. `OPENAI_API_KEY` present (non-blank). The key is read from the environment as a
   bearer credential; it never enters the trace, logs, or agent context.
4. `CI` unset.

```bash
E2E_REAL=1 OPENAI_API_KEY=sk-... node --experimental-strip-types gateloop/scripts/e2e-real-provider.ts
```

The real path: secret handle → live-provider bootstrap (028.2) → registered adapter →
budget-guarded routed call → validated output → budget decrement.

## Rollback

Delete `scripts/e2e-real-provider.ts`; the deterministic greenfield E2E (013.1,
`scripts/e2e-greenfield.ts`) remains the standing artifact-generation proof.
