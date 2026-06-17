# Complete Technical Stack

## Frontend

- Vite
- React
- TypeScript
- TailwindCSS or shadcn/ui
- TanStack Query
- Zustand or Jotai
- Monaco Editor for diffs and file views
- xterm.js for terminal logs
- React Flow for codegraph/storygraph visualization

## Backend

- Node.js LTS
- TypeScript
- Fastify
- WebSocket or Server-Sent Events for trace streaming
- Zod for runtime validation
- SQLite for MVP storage
- PostgreSQL optional after MVP

## Monorepo

- pnpm workspaces
- TypeScript project references
- Vitest
- ESLint
- Prettier
- tsup or unbuild for package builds

## Execution and isolation

- Git worktree for disposable workspaces
- Docker or Podman rootless for sandbox execution
- seccomp/AppArmor where available
- no host Docker socket in containers

## Code intelligence

- codegraph adapter for external codegraph project integration
- ripgrep fallback
- TypeScript compiler API for TS symbol extraction later

## Secrets

- OS keychain / 1Password / Vault adapter later
- secret handles only in model-facing context
- child-process env injection only after approval

## Agent providers

- Provider adapter interface only at first
- no real API in early stories
- future support for Claude Code CLI, OpenAI, Anthropic, local models
