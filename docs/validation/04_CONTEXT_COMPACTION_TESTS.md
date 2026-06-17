# Context Compaction Tests

Assert the Context Manager compacts safely (see
`../architecture/04_CONTEXT_AND_MEMORY_MODEL.md`).

| # | Case | Expected |
| --- | --- | --- |
| 1 | a turn is summarized | the raw artifact is still retrievable (append-only trace untouched) |
| 2 | a summary is produced | it carries a `source_ref` to the original |
| 3 | logs contain a secret | the secret is redacted before entering context |
| 4 | Supervisor context assembled | it does **not** contain the full Developer trace (summaries only) |
| 5 | Debugger context assembled | it **does** contain the relevant failed logs |
| 6 | compression requested below ratio 0.3 | refused (floor enforced) |
| 7 | first 3 / last 5 turns | never compressed (pinning) |
| 8 | 10th agent call | contract + active failure genes re-injected |
| 9 | 20th agent call | rules/invariants re-injected |
| 10 | per-agent token budget exceeded | reduced by artifact **selection**, not by dropping the trace |
