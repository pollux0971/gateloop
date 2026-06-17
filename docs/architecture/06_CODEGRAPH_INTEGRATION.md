# CodeGraph Integration (shared code-intelligence)

CodeGraph is the harness's structural code-intelligence backend. It pre-indexes
a repo into a queryable graph (symbols, call graph, dependency edges) over real
ASTs across 20+ languages, and exposes it to agents over an MCP server. It backs
the shared `codegraph-query` skill that Supervisor / Developer / Debugger all use
for impact analysis and orientation.

- Vendored copy: `external_references/open_source_projects/codegraph/` (MIT, pinned 0.9.9). See its VENDORED.md.
- Upstream: https://github.com/colbymchenry/codegraph

## How it plugs in

It is a deterministic tool, not an agent. Agents request a codegraph query; the
Tool Executor runs it through the Permission Gateway like any other tool; results
are returned and recorded to the trace as `tool_call` / `tool_result` events.

```text
agent (codegraph-query skill) → Tool Executor → codegraph MCP server → graph index (.codegraph/)
```

Two ways to run it:

1. **As a dependency (recommended).** `npx @colbymchenry/codegraph` indexes the
   repo and serves MCP. Pin the version. The harness wires the MCP server into
   the Tool Executor's allowed tools. Upgrades are a version bump.
2. **From the vendored copy (offline/reproducible).** Build from
   `external_references/open_source_projects/codegraph/` when network installs are not allowed. Heavier to
   maintain; do not patch — re-vendor to upgrade.

## Index lifecycle

- Build the index once at `/goal` Step 0 (environment bootstrap) after the env
  snapshot, so the first stories already have a graph to query.
- Re-index incrementally after a checkpoint that changed indexed files (codegraph
  supports incremental parsing).
- The `.codegraph/` index directory is harness state, not agent-writable.

## Boundary notes

- codegraph answers structural questions ("who depends on X", "call graph of Y",
  "where is symbol Z defined"). It is not a substitute for the Validator — it
  never says pass/fail.
- Queries are read-only; codegraph has no write path, so it carries no write-set
  risk. Its MCP server is an allowed read tool, not a loophole for other APIs.
