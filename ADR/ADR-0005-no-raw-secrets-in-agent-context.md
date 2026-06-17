# No raw secrets in agent context

## Status

Accepted for planning.

## Context

Agents can leak or misuse secrets if exposed in prompts or logs.

## Decision

Use secret handles and child-process injection only.

## Consequences

Requires Secret Broker, redaction, and approval records.
