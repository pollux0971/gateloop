# Settings Model (VSCode-style)

Some choices are one-time architecture decisions (they belong in the backlog and
the code). Others are parameters a user should retune per project or per run
without editing code — exactly the line VSCode draws between its source and
`settings.json`. This document defines that second category for GateLoop.

## Three-layer precedence (highest wins)

```text
1. story / contract override   — per-story, in the story contract (narrowest)
2. workspace settings          — settings.yaml in the target project (gitignored)
3. settings.default.yaml        — shipped defaults (read-only; copy keys to override)
```

The effective value of any key is resolved top-down at boot. The resolved
settings object is recorded in the trace so every run is reproducible.

## What is and is NOT a setting

A setting may **relax cost or quality** (smaller budget, fewer quality checks,
sequential instead of parallel). A setting may **never weaken a trust boundary.**

Therefore the four global gates — `real_api_calls`, `sudo_broker_runtime`,
`bypass_workspace_runtime`, `stable_promotion` — are deliberately **not
representable** in the settings schema. They stay human gates. `model.real_provider_scope`
can *prefer* hybrid/all/none, but it is still capped by the `real_api_calls`
gate: preferring `all` while the gate is off changes nothing.

## Validation

`settings.default.yaml` and any `settings.yaml` are validated at boot against
`specs/settings.schema.json` (`additionalProperties: false`, enums, ranges).
An unknown key or out-of-range value fails boot loudly — the same
declaration-must-be-checked rule as `stub_registry.json`.

## Decision → setting mapping

These former open decisions become tunable settings (their backlog defaults
become the shipped defaults):

| Decision | Setting key |
| --- | --- |
| D1 project type | `target.project_type` |
| D4 real-provider scope | `model.real_provider_scope` |
| D5 parallelism | `parallelism.*` |
| D6 quality bar | `quality_bar.greenfield` |
| D7 budgets | `budget.*` |
| D8 promotion target | `delivery.promotion_target` |
| D9 gate interface | `delivery.human_gate_interface` |
| D11 failure-bank scope | `failure_bank.scope` |
| D12 stack | `target.stack` |
| D13 brownfield strictness | `quality_bar.brownfield_strictness` |
| D14 recovery depth | `brownfield.recovery_depth` |

Decisions that are NOT settings (one-time architecture, stay in the backlog):
D2 (sandbox-only output — a safety invariant), D3 (provider auth mechanism — an
implementation choice), D10 (whether to build whole epics — a planning choice).
