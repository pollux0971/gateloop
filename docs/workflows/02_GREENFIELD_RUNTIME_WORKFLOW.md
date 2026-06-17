# Greenfield Runtime Workflow

Runtime flow when the target is **new code** (no existing implementation to respect).
`task_class: greenfield`. Bias: scaffold-first, additive, smallest viable structure.

```text
Story Contract (greenfield)
  → Supervisor issues Developer Task Packet (create-set defined)
  → Developer: scaffold the module/files in the workspace branch (additive)
  → [Permission Gateway] workspace-only apply
  → Validator: run validation_commands + required_validators
       ├─ PASS → Checkpoint draft → human merge
       └─ FAIL → Debug Loop (04)
```

## Rules
- Create only the files in `required_files.create` / `allowed_write_set`; do not
  pre-build beyond the story.
- Tests that encode `acceptance_criteria` are authored by a non-implementer (or
  human-confirmed at checkpoint) — see Supervisor doc, acceptance-test integrity.
- No promotion here; greenfield output is still workspace-only until promoted (06).

See `00_PRODUCT_MASTER_WORKFLOW.md`, `../architecture/02_RUNTIME_STATE_MACHINE.md`.
