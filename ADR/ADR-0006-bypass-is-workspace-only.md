# Bypass mode is workspace-only

## Status

Accepted for planning.

## Context

Dangerously skipping permissions is useful for speed but unsafe on host systems.

## Decision

Implement bypass_workspace only inside disposable sandbox/workspace.

## Consequences

Provides autonomy without unbounded host access.
