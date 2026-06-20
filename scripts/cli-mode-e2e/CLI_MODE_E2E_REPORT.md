# CLI-Mode E2E (STORY-034.5) — Stage 3 report

**Date:** 2026-06-20 · `real_api_calls = false` (untouched) · **no Claude spawned, no spend.**

Stages 1–2 (commit `bf86c18`) built a real, OS-enforced cage and proved isolation on a real
busybox process. Stage 3 builds a **node/claude-capable cage**, re-proves isolation as an
automatic program gate, and would auto-spawn real Claude Code if the gate passes. The gate
**passes** — but two real preconditions (neither an isolation crack) block the spawn.

## Stage 3a — claude cage image (built, offline)

Investigation flipped the plan in a good way:
- **node is a snap** (`/snap/bin/node` → snapd-confined) — not cleanly mountable into a
  `--network none` container. But…
- **claude 2.1.179 is a self-contained 240 MB ELF** (`~/.local/share/claude/versions/2.1.179`)
  that needs only **glibc** — **no node required**. It runs standalone (`HOME=/tmp/nohome
  claude --version` → `2.1.179`).

So `build-claude-cage-image.sh` builds a **fully self-contained** image OFFLINE (no pull):
busybox + the claude ELF + its glibc deps (via `ldd`) — and **nothing from `$HOME`** beyond the
claude program binary. The running cage has **zero host bind mounts** except the sandbox copy
at `/work`, so secrets cannot be dragged in by construction. `claude --version` runs inside the
cage (`--network none`, read-only root, only `/work` writable). Image: `cage-claude:latest`
(246 MB).

## Stage 3b — automatic isolation gate (PASSES 5/5)

`prove-cage.ts cage-claude:latest` runs a real busybox probe **inside the claude cage** and
re-proves every invariant — the program gate before any spawn:

| Invariant | Result |
|---|---|
| real process cannot read host secret (fake `.env` + real `~/.ssh`/`~/.codex`/`gateloop/.env`) | ✅ HELD |
| writes confined, host tree untouched (`/`,`/etc`,`/bin` refused; `/work` lands on host sandbox) | ✅ HELD |
| network denied (`nc`+`wget` egress fail under `--network none`) | ✅ HELD |
| broker auth in cage env only; key absent from sandbox disk; host `HOME` not inherited (`HOME=/work`) | ✅ HELD |
| **no `$HOME`/secret/config baked into the image** (`find` for `.claude*`/`auth.json`/`.env`/`.ssh`/`.npmrc`/`credentials` → none; `/home` empty) | ✅ HELD |

Gate exit 0 → the auto-gate would permit the spawn. **Baking claude in did NOT drag in any
secrets** — the Stage-3 attack surface is closed. (Zero cost: busybox probe, fake secret, no
Claude, no real network egress.)

## Stage 3c — BLOCKED before spawn (two real preconditions, not isolation cracks)

The isolation gate passes, but real Claude cannot run yet:

**1. Auth not provisioned.** `claude --bare` authenticates **strictly via `ANTHROPIC_API_KEY`**.
That key is **absent** from the broker env file (`gateloop/.env` has the DeepSeek/OpenAI keys
from the router eval, not Anthropic). The subscription credential lives in `~/.claude` —
**exactly what rule 1 forbids mounting** (it's the secret-dragging hole the cage prevents). So
there is no clean credential for the broker to inject. **Resolution: you add a credential to the
broker env** — either `ANTHROPIC_API_KEY=...` (API billing, `--bare` uses it directly) or, for
subscription billing, a `CLAUDE_CODE_OAUTH_TOKEN` the broker can inject via env (so the token
never becomes a file mount). I will not read or mount `~/.claude`.

**2. Network isolation vs. the model API — unresolved design tension.** The **proven** cage is
`--network none`. But Claude Code must reach **`api.anthropic.com`** to run the model — and the
033 delegation allowlist permits only package registries (`registry.npmjs.org`, `pypi.org`, …),
**not the model API host**. So even with auth, the airtight cage blocks Claude's own API call →
no work happens. Bridging this needs a **narrow, airtight egress path to only
`api.anthropic.com`** (a filtering proxy or per-host egress allowlist), which is **not built**
— and is itself security-sensitive: a too-loose allowlist reopens exfiltration (the very thing
`--network none` prevents). This is a design decision, not a one-line flag.

## Honest conclusion

- The cage is **real and proven**, and the Stage-3 mounting/baking attack surface is **closed**
  (5/5 invariants hold with claude in the image; no secrets dragged in).
- The minimal CLI-mode bridge is **end-to-end ready except for the two preconditions above**.
  Neither is an isolation failure — they are (a) credential provisioning (yours), and (b) a real
  isolation-vs-model-API design choice (a narrow egress allowlist to `api.anthropic.com`).
- **Nothing was spent.** I stopped at the precondition wall rather than weaken isolation (mount
  `~/.claude`) or open the network broadly. Both would defeat the point of the cage.

## To unblock Stage 3c

1. Provide a credential to the broker env (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`) —
   never a `~/.claude` mount.
2. Decide the egress approach to `api.anthropic.com`: a host-side filtering proxy the cage uses
   via `HTTPS_PROXY` (cage stays `--network none` except to the proxy), or a per-host egress
   allowlist. I’ll build + re-prove (the egress must allow ONLY the model host) before spending.

Then the gated runner spawns real Claude Code in the proven cage, records its bash from the
observation stream (the real isolation test), gates the diff, and auto-closes via runGated.
