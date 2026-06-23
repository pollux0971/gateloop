# Secret and Sudo Broker

## Rule

Agents must never receive raw secrets.

## Secret handles

Agents request handles such as:

```text
provider.openai.default
provider.anthropic.default
github.readonly.token
```

The Secret Broker injects secrets only into a child process environment after policy approval. Logs must be redacted.

## Trace/log secret masking — hygiene, not a wall (ADR-0013, STORY-TRUST.3)

Trace/log secret masking (the `redact()` family in event-log, plus the pre-sync secret
scan in harness-core) is one of the **two KEPT hygiene defaults** under the operator-trust
model. It is **HYGIENE, not a security wall**: it prevents the operator's **own** API keys
from accidentally leaking into a committed trace, log, or screenshot. It does **not**
restrict what the agent may do, and nothing about it is an execution-side protection — so
no doc may frame it as a wall (leave no phantom defense). It stays **functional** (masking
still runs); only its framing is honest now: accidental-leakage prevention for the operator,
not a gate on the agent. The other kept hygiene default is the force-push pre-backup
(auto-bundle before a force-push) — see `packages/harness-core/src/protectiveBackstops.ts`.

## Sudo policy

Host sudo is not available to agents by default.

Allowed approaches in order:

1. rootless container
2. container-root inside isolated container
3. human-run setup script
4. extremely narrow sudoers allowlist
5. askpass wrapper only for allowlisted commands

Never store sudo passwords in repository files.
