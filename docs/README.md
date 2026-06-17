# GateLoop — Product (Runtime) Docs

How the GateLoop platform's multi-agent system operates **on a user's project**.

- `architecture/` — system, agent topology, runtime state machine, tool/permission, context/memory, skill runtime, codegraph.
- `workflows/` — runtime workflows (idea→epic, greenfield, brownfield patch, debug, parallel, promotion, compaction, skill lifecycle).
- `agents/` — per-agent runtime specs and boundaries.
- `contracts/` — runtime artifacts exchanged between agents/harness.
- `policies/` — permission, promotion, rollback, compaction, secret, sandbox.
- `validation/` — runtime invariants and stability/security/gate tests.

This is **not** how you build GateLoop — see `../builder/`.
