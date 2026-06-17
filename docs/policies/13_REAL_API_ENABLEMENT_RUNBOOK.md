# Real API Calls Enablement Runbook

**Audience:** human operator  
**Gate owner:** human only — no agent or story may flip this gate  
**Default state:** `real_api_calls.enabled: false` (CI-safe)

---

## What this gate controls

Setting `real_api_calls.enabled: true` in `configs/policy.yaml` causes
`createRealProvider` in `packages/model-gateway` to instantiate live HTTP
adapters instead of returning the disabled stub. Until this flag is set, every
`llm_remote` provider call returns a structured error and no network traffic
leaves the machine.

---

## Prerequisites (must be verified before enabling)

1. **Budget guard active.** `BudgetGuard` is wired into every gateway call via
   `guardedCall`. Defaults: 30 calls / 400k tokens per story (configurable in
   `model_routing.yaml → budgets`).
2. **Kill switch available.** Set `real_api_calls.kill_switch: true` in
   `policy.yaml` at any time to halt all real provider calls immediately.
3. **Codex OAuth login complete** (if using `codex` provider).
   Run: `pnpm --filter @gateloop/codex-auth exec ts-node src/cli.ts login`
   The browser sign-in is itself the human gate for the OAuth flow.
4. **Secret handles configured.** API key providers (deepseek, openai, anthropic)
   require their `handle` to be registered with the Secret Broker before the
   gateway can fetch credentials. The handle names are in `configs/providers.yaml`.
5. **CI environment unaffected.** Confirm `CI=true` or equivalent is set in your
   CI runner. The gateway reads this env var and keeps `enabled: false` regardless
   of `policy.yaml` when running under CI.

---

## How to enable (step by step)

### Step 1 — Open `configs/policy.yaml` in your editor

```yaml
real_api_calls:
  enabled: false      # ← change to true
  kill_switch: false
```

Change `enabled` to `true`. This is the only config change required.

### Step 2 — Record the change in the trace

Append one line to `builder/tracker/decision_log.md`:

```
YYYY-MM-DD HH:MM | human | real_api_calls | enabled: false -> true | operator: <your name>
```

This is the audit record that `enablement_recorded_in_trace` acceptance criterion
verifies. The harness does not write this line — the human must.

### Step 3 — Verify the guard is active

```bash
node -e "
const { BudgetGuard } = require('./gateloop/packages/model-gateway/dist/index.js');
const g = new BudgetGuard('smoke-test');
console.log('BudgetGuard check:', g.check());
"
```

Expected: `{ ok: true }`.

### Step 4 — Run a smoke test with one scripted story

Before any real agent work, run the full-loop skeleton once to confirm the
gateway routes correctly:

```bash
node --experimental-strip-types gateloop/scripts/full-loop-skeleton.ts
```

The skeleton uses the scripted provider by default. Confirm it reaches
`CHECKPOINT` without errors. Real provider calls begin only when an agent's
routing config resolves to an `llm_remote` provider.

---

## Hybrid routing scope (DECISION D4)

| Agent | Provider in routing config | Real calls? |
|---|---|---|
| Developer | `codex` (primary) → `deepseek` (fallback) | ✓ when enabled |
| Debugger | `codex` (primary) → `deepseek` (fallback) | ✓ when enabled |
| Supervisor | `codex` (primary) → `deepseek` (fallback) | ✓ when enabled |
| Planning Steward | `codex` (primary) → `deepseek` (fallback) | ✓ when enabled |

All agents use the same `llm_remote` adapter path. Keeping Supervisor and
Planning Steward on scripted providers requires manually overriding their routes
in `model_routing.yaml` — not the default.

---

## How to disable (one command)

```bash
# Option A — flip the flag back
sed -i 's/enabled: true/enabled: false/' gateloop/configs/policy.yaml

# Option B — activate kill switch immediately (stops calls without restart)
sed -i 's/kill_switch: false/kill_switch: true/' gateloop/configs/policy.yaml
```

Append one audit line to `decision_log.md` either way.

---

## What the gate does NOT do

- Does not prevent scripted or fixture provider calls (those are always allowed).
- Does not affect CI runs (CI env var keeps the gate off independently).
- Does not store or rotate credentials (that is the Secret Broker's job).
- Does not authorize external tool-API calls (that is the Permission Gateway).
