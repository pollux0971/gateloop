# GateLoop (product)

A training-free, multi-agent software-development harness: four LLM agents
(Planning Steward, Supervisor, Developer, Debugger) over a deterministic harness
layer (orchestrator, permission gateway, validator, workspace/secret managers).

This folder is **self-contained** and intended to become its own git repository.
It must not reference anything outside itself (the build cockpit lives one level
up in `../builder/` and is not part of the product).

- `docs/` — runtime architecture, workflows, agents, contracts, policies, validation.
- `specs/` — runtime JSON schemas + the API spec.
- `configs/` — runtime config (decision matrix, context manager, providers, policy, …).
- `packages/` — TypeScript skeletons for the harness + agent runtimes.
- `skills/` — agent skill packages.
- `apps/` — console / web / api.
- `ADR/` — runtime architecture decisions.

Entry point: `docs/00_START_HERE.md`.
