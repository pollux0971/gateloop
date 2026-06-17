# Warning Bank (Failure Gene Store)

The warning bank is the harness's memory of validated failure patterns. The
Debugger writes to it; the Context Manager reads from it.

## What lives here

- `warning_bank.json` — all active failure genes (indexed by id, keyed on
  `matching_signal` for deduplication). The source of truth for injection.
- `archive/` — resolved or superseded genes; kept for audit, never injected.

## Lifecycle (one gene, start to finish)

```text
story fails → Debugger diagnoses root cause, repair succeeds
  → Debugger produces a FailureGene per specs/failure_gene.schema.json
  → failure-bank.bankGene(gene):
        if matching_signal already exists in bank:
          increment consolidated_count, optionally strengthen AVOID
          (selective, not additive — do not create a second entry)
        else:
          append new gene
  → before the next Developer turn on a matching story:
        Context Manager calls injectRelevant(story_context, maxK=5)
        Injects only the compact AVOID lines, not full history
```

## Injection format (what the Developer sees)

```
## Known failure patterns for this context
[fg-001] AVOID: Do NOT add barrel exports without verifying no circular imports (madge --circular).
[fg-003] AVOID: NEVER mutate shared config objects; clone first with structuredClone().
```

Two lines per gene, no story ids or metadata — just the AVOID signal. The
Debugger's full diagnostic lives in the trace, not here.

## Governance

| Parameter | Default | Config |
| --- | --- | --- |
| Max active genes | 50 | `configs/failure_bank.yaml` |
| Max genes injected per turn | 5 | `configs/failure_bank.yaml` |
| `consolidated_count` ≥ 2 | recurring pattern | escalate earlier in decision matrix |
| Bank size > max | run `consolidate()` | merge near-duplicates, archive stale |

## Two levels of failure memory

- **This bank** — cross-story patterns; injected before Developer turns.
- **Skill `.memory.md`** — per-skill pitfalls; surfaced when that skill is loaded.
Neither replaces the other. A skill failure that also reveals a general pattern
should have entries in both.
