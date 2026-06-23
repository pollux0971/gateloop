# No raw secrets in agent context

## Status

Accepted for planning. · **Amended by ADR-0013 (2026-06-23, STORY-TRUST.6)** — recast as a **hygiene default, not a security wall**: trace/log secret masking is **KEPT and still functional** (it prevents the operator's *own* keys from leaking into committed traces/logs — accidental-leakage prevention, not a restriction on the agent). Amended, **not** superseded, because the masking mechanism stays. See `ADR/ADR-0013-no-sandbox-operator-trust.md` + STORY-TRUST.3.

## Context

Agents can leak or misuse secrets if exposed in prompts or logs.

## Decision

Use secret handles and child-process injection only.

## Consequences

Requires Secret Broker, redaction, and approval records.
