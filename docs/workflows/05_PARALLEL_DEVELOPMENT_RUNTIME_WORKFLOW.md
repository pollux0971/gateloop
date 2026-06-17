# Parallel Development Runtime Workflow

**v1 feature (out of v0 scope).** How independent stories run concurrently without
clobbering each other. The Supervisor decides *what* may parallelize; a deterministic
Scheduler decides *how*.

```text
Supervisor (reads parallelism_class) marks a parallel-safe set
  → Scheduler spawns N Developer workers, one isolated git worktree each
  → each worker: patch within its own allowed_write_set (disjoint by construction)
  → Workspace Manager: conflict detection across worktrees
  → barrier → Integration Manager merges into an integration workspace
  → Validator runs combined tests on the integration workspace
  → Supervisor review → checkpoint
```

## Parallelism classes (from the Story Contract)
`sequential` (default) · `parallel_safe` (disjoint write-sets) · `barrier` (must
join before the next phase) · `exclusive` (must run alone — e.g. schema or policy change).

## May NOT parallelize
Two stories writing the same file · a schema change with a dependent · a permission/secret
change with anything · a public-API change with its client · a debug whose scope exceeds
its branch.

## Rules
- The Supervisor stays **singular** (one governor); it does not become multi-threaded.
- Workers get **isolated** worktrees + disjoint write-sets; merges go through an
  integration barrier, never worker-by-worker.
- This entire workflow is deferred until the single-thread loop is stable.

See `../agents/02_SUPERVISOR_AGENT.md` (v0 non-goals), `packages/workspace-manager`.
