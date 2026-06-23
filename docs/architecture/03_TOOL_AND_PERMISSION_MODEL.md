# Permission Gateway

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

## Purpose

The Permission Gateway decides whether a tool request is allowed, denied, or requires human approval.

## Modes

```text
plan              read-only and no mutation
ask               ask for risky operations
accept_edits      allow writes inside story write-set
bypass_workspace  high autonomy inside disposable workspace only
deny_unlisted     allow only explicit allowlist tools
```

## Decision output

```json
{
  "decision": "allow | ask | deny",
  "reasons": ["string"],
  "riskLevel": "low | medium | high | critical",
  "requiredApproval": "none | user | maintainer | security"
}
```

## Hard deny examples

- write outside workspace
- read secret file
- write `.git`
- mount Docker socket
- disable sandbox profile
- destructive host command

## Ask examples

- network escalation
- provider API use
- policy edit
- stable branch edit
- sudo request
