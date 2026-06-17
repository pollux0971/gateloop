# Permission Gateway

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
