# Bypass mode is workspace-only

## Status

Accepted for planning. · **Amended by ADR-0013 (2026-06-23, STORY-TRUST.6)** — reframed: under the operator-trust model there is **NO execution-side sandbox wall**. "Workspace-first" is **KEPT** as a workflow convention (changes land in a disposable workspace for review/rollback), **not** as a security boundary. Amended, **not** superseded, because the workspace-first workflow stays. See `ADR/ADR-0013-no-sandbox-operator-trust.md`.

## Context

Dangerously skipping permissions is useful for speed but unsafe on host systems.

## Decision

Implement bypass_workspace only inside disposable sandbox/workspace.

## Consequences

Provides autonomy without unbounded host access.
