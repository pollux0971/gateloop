# Brownfield Patch Runtime Workflow

Runtime flow for changing an **existing** codebase. `task_class: brownfield`.
Bias: localize, minimal additive change, do not break regressions.

```text
Story Contract (brownfield) + brownfield intake (the repo to patch)
  → CodeGraph/LSP impact analysis (what depends on the change)
  → Supervisor issues Developer Task Packet (tight allowed_write_set)
  → Developer: minimal localized patch (additive-first) in the workspace branch
  → [Permission Gateway] workspace-only apply
  → Validator: targeted tests + regression suite + required_validators
       ├─ PASS → Checkpoint draft → human merge
       └─ FAIL → Debug Loop (04)
```

## Rules
- **Impact first**: use CodeGraph (breadth/dependents) + LSP (precise references) to
  bound the change; the write-set must cover only the impacted files.
- Run the **regression suite**, not just new tests — brownfield's main risk is breaking
  existing behavior.
- Out-of-write-set need ⇒ stop → human-approved contract revision (do not self-expand).

See `../architecture/06_CODEGRAPH_INTEGRATION.md`, `04_DEBUG_LOOP_RUNTIME_WORKFLOW.md`.
