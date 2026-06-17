# Context Compaction Runtime Workflow

How the Context Manager keeps a long run inside budget without losing truth. Model:
`../architecture/04_CONTEXT_AND_MEMORY_MODEL.md`. Config: `configs/context_manager.yaml`.

```text
each agent turn:
  pin first 3 + last 5 turns
  if node > ~4k tokens   → compress node (L1), keep source_ref
  if chain > ~60k tokens → compress chain (L2), never below ratio 0.3
  keep last 20 turns live (sliding window)
  every 10 calls → re-inject contract + active failure genes
  every 20 calls → re-inject rules/invariants
  redact secrets before anything enters context
```

## Rules
- **Never destroy the raw trace** — compaction summarizes the *active context*; the
  append-only event log is untouched and every summary keeps a `source_ref`.
- Over-compression hurts: the floor (0.3) is a hard stop.
- The Supervisor never receives full Developer traces; only summaries.

See `../architecture/12_RUNTIME_ALGORITHM_RULES.md` §6, `../validation/04_CONTEXT_COMPACTION_TESTS.md`.
