# Harness Engineering Model

Harness engineering means optimizing the code around an LLM: what context is stored, retrieved, compacted, shown, validated, and executed.

## Objective

Reduce routine human-in-the-loop approvals while preserving hard safety gates.

## Harness loop

```text
Plan -> Context Packet -> Agent Output -> Tool Request -> Permission Decision -> Execution -> Trace -> Validation -> Next State
```

## Automation policy

Routine low-risk operations should be automatically allowed:

- read allowed files
- inspect codegraph
- generate patch proposal
- write inside disposable workspace write-set
- run allowlisted tests
- update non-protected docs

Boundary-crossing operations require ask or deny:

- secrets
- sudo
- stable promotion
- security policy changes
- network escalation
- destructive deletion
- protected path mutation
