# Start Here — GateLoop (product)

> **v0 complete (2026-06-11).** All 25 v0 stories (EPIC-000 through EPIC-007) are
> done. Promotion review approved (`APPROVE_WITH_NON_BLOCKING_NOTES`). The
> deterministic core runs end-to-end under the scripted provider with no LLM.
>
> **Next implementation story:** `STORY-008.1 — Implement preflight runner`
> (deps: STORY-003.4, parallel_safe).
>
> **Do not start EPIC-011 (real provider) until STORY-013.1 (deterministic E2E)
> passes and the human explicitly opens the `real_api_calls` gate per STORY-011.4.**
>
> **Follow `builder/tracker/tracker_state.json` for current story status.**
> Do not rely on zip file tracker states — they may be stale.


This is the **product**: how GateLoop's multi-agent system operates on a
user's project. (How this product is *built* with Claude Code lives outside the
product, in `../builder/`.)

## Map
- `docs/architecture/` — `00_SYSTEM_OVERVIEW`, `01_AGENT_TOPOLOGY`, `02_RUNTIME_STATE_MACHINE`, `03_TOOL_AND_PERMISSION_MODEL`, `04_CONTEXT_AND_MEMORY_MODEL`, `05_SKILL_RUNTIME_MODEL`, `06_CODEGRAPH_INTEGRATION`, `07_MODEL_PROVIDER_GATEWAY`, `08_HARNESS_ENGINEERING_MODEL`, `09_PROGRAM_ARCHITECTURE`, `10_TECH_STACK`, `11_CODEX_OAUTH_LOGIN`, `12_RUNTIME_ALGORITHM_RULES`.
- `docs/workflows/` — runtime workflows (master, idea→epic, greenfield, brownfield patch, debug loop, parallel, promotion, context compaction, skill lifecycle).
- `docs/agents/` — boundaries + the four agent specs.
- `docs/contracts/` — HARNESS_CONTRACT, CONTEXT_PACKET, TRACE_SCHEMA, PATCH_PROPOSAL, STORY_CONTRACT, FAILURE_GENE.
- `docs/policies/` — security model, permission, promotion, rollback, context compaction, secret, container sandbox.
- `docs/validation/` — runtime invariants and stability/boundary/security/compaction/promotion tests.
- `specs/` — runtime JSON schemas (+ `specs/api/openapi.yaml`).
- `configs/` — decision_matrix, context_manager, providers, model_routing, policy, failure_bank, container_profiles, secret_handles.
- `packages/` — harness-core + the four `*-runtime` agents + permission-gateway, workspace-manager, context-manager, event-log, validator-suite, skill-runtime, skill-tester, failure-bank, codegraph-adapter, model-gateway, codex-auth, shared.
- `skills/` — planning-steward / supervisor / developer / debugger / shared skill packages.
- `apps/` — `console/` (interactive mockup), `web/`, `api/`.
- `docs/failure_bank/` — live warning-bank data.

CodeGraph (the codegraph-adapter's backend) is consumed as a dependency
(`@colbymchenry/codegraph`); a vendored reference copy lives in the workspace
at `../external_references/open_source_projects/codegraph/`.
