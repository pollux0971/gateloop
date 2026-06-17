# @gateloop/web — Cockpit

Vite + React cockpit that fetches `@gateloop/api` and renders the agent **skill
catalog**, the **conversation** (agent dialogue of a run), and the **platform**
(packages, escalations, external plugins).

- Start API:  `pnpm --filter @gateloop/api dev`  (serves on :8787)
- Start web:  `pnpm --filter @gateloop/web dev`
- API base override: `VITE_API=http://host:port`

A dependency-free, self-contained hi-fi view (embeds a live repo snapshot, no build)
lives at `../console/index.html` — open it directly to render the cockpit anywhere.
External design plugin (huashu-design) is surfaced under "External plugins"; it is NOT
part of the agent skill graph.
