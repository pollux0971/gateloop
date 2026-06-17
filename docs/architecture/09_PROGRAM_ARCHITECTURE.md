# Program Architecture

## TypeScript monorepo

```text
apps/web                  Vite + React cockpit
apps/api                  Fastify API and WebSocket event stream
packages/shared           shared types and schema helpers
packages/harness-core     workflow state machine and run orchestration
packages/planning-steward idea classification and planning bundle generation
packages/permission-gateway policy decision engine
packages/workspace-manager worktree and patch workspace control
packages/container-runtime container profile runner
packages/secret-broker    secret handle and sudo-broker interface
packages/context-manager  role-specific context packet builder
packages/event-log        append-only trace events
packages/skill-runtime    skill package manifest and loader
packages/validator-suite  deterministic validators
```

## Data stores

Development MVP may use SQLite. Later, PostgreSQL can replace it.

Tables to plan:

- projects
- ideas
- planning_bundles
- epics
- stories
- runs
- trace_events
- tool_requests
- permission_decisions
- artifacts
- approvals
- promotions
- rollback_records

## Runtime boundary

Claude Code CLI may modify repository files only according to story contracts. The future app should run tool calls through the Permission Gateway and Workspace Manager.
