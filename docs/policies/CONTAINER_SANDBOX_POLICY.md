# Container Sandbox

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

## Default profile

- rootless
- network disabled
- read-only root filesystem
- drop all capabilities
- no new privileges
- no host Docker socket
- CPU/memory/time limits
- stable repo read-only
- disposable workspace writable

## Bypass workspace mode

`bypass_workspace` is not equivalent to host-level dangerously-skip-permissions. It only means fewer prompts inside a disposable sandbox.
