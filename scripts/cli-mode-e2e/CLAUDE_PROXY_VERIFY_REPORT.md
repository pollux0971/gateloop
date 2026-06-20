# CLAUDE_PROXY_VERIFY — does real Claude Code honor HTTPS_PROXY in the hardened `--internal` cage?

**Verdict: YES — Claude routes its API traffic through `HTTPS_PROXY`. The spawn-CLI
architecture is COMPLETE AND USABLE.**

**Date:** 2026-06-20 · run `cli_mode_claude_proxy_verify_20260620_202810` · cost: subscription
credits (negligible — 216 output tokens, one turn). `real_api_calls` opened by `runGated` →
ran → **auto-closed + read-back verified false**.

This run answers the single blocking unknown left open by 034.5 hardening (run#11): the egress
boundary was proven with a *busybox* probe (which honors the proxy env), but it was unknown
whether **real Claude Code** honors `HTTPS_PROXY` on the no-gateway `--internal` net — or
ignores it and gets blocked with no route (which would force a transparent/iptables redirect).

## The two possible outcomes, and which one happened

| Outcome | Meaning | This run |
|---|---|---|
| **Claude goes through the proxy** (proxy.log has records + story completes) | Both defense layers real **and** Claude runs → architecture complete & usable | ✅ **THIS** |
| Claude ignores the proxy (can't reach API, story fails; `--internal` no route blocks direct) | Safe but unusable — needs transparent/iptables redirect | ✗ not this |

## The decisive observation — proxy.log is NOT empty (contrast 034.5)

```
2026/06/20 12:28:11 PROXY_LISTENING 8889 allowlist=[api.anthropic.com:443]
2026/06/20 12:28:12 CONNECT api.anthropic.com:443 -> ALLOWED
2026/06/20 12:28:12 CONNECT api.anthropic.com:443 -> ALLOWED
2026/06/20 12:28:12 CONNECT api.anthropic.com:443 -> ALLOWED
```

Three `CONNECT api.anthropic.com:443 -> ALLOWED` records — the exact contrast to 034.5's
**empty** `proxy.log` (where Claude reached the API directly via the bridge gateway). On this
run the cage was on a no-gateway `docker network create --internal` net — it has **NO direct
route out**; the proxy container is the **only** egress. Therefore:

- **The story completed** (Claude reached the API and produced output) — proof Claude got out.
- **The only way out was the proxy** (`--internal`, proven blocked-direct by `prove-egress.ts`).
- ⟹ **Claude routed its Anthropic traffic through `HTTPS_PROXY`.** Both facts together — log
  non-empty AND story done — are only consistent with Claude honoring the proxy env. If it had
  ignored it, the `--internal` net would have blocked it (no route) and the story would have
  failed with an empty log.

## Story completed — the gated work ran inside the cage

- Trivial story (same magnitude as 034.5): create `slugify.mjs` (lowercase → trim → collapse
  non-alphanumeric runs to `-` → strip edge hyphens), pure ESM.
- **Result:** Claude created `/work/slugify.mjs`. Diff vs the pre-delegation tree (authoritative):
  `slugify.mjs` only.
- **Exit gate (write-set crux): ACCEPTED** — `out_of_write_set = []`.

## Isolation review (observation stream)

```
tool_use:Write   →  /work/slugify.mjs
```

**One `Write`, to `/work` only.** No `Bash`, no host-path `Read`, no attempt to reach
`~/.claude` / `~/.ssh` / `~/.codex` / `.env`, no write outside `/work`. The real autonomous CLI
stayed entirely within the sandbox — in practice and (per the Layer-2 proof) by construction.

## Layer-2 auto-gate (the backstop — still verified, not skipped)

Immediately before spawn, a real busybox probe in the EXACT cage config proved, zero-cost, 4/4
HELD:

| Invariant | Result |
|---|---|
| cage cannot read ANY host secret (fake `.env` + real `~/.claude/.credentials.json`, `~/.ssh`, `~/.codex`, `gateloop/.env`) | ✅ HELD |
| writes confined, host tree untouched | ✅ HELD |
| injected token in cage env only, absent from sandbox disk, `HOME` not host | ✅ HELD |
| no `$HOME`/credential file baked into the image (only a non-secret onboarding `.claude.json`) | ✅ HELD |

Gate held → spawn permitted. Had any held=false, the run would have aborted before spawning.

## Token handling (broker, zero landing)

The broker (`readClaudeOAuthToken`) read `~/.claude/.credentials.json` in a child process
(108-char token, **never printed** — every line token-redacted), and the value flowed
broker → `process.env` → `docker --env CLAUDE_CODE_OAUTH_TOKEN` (passthrough by NAME, never in
argv). No new file written; mode-600 original untouched; cage never mounts the file. The proxy
tunnels TLS via CONNECT, so it never sees the token either.

## Cost

`usage`: input 4 · cache_creation 6421 · cache_read 37961 · **output 216** tokens ·
service_tier standard · subscription. One model turn. Negligible.

## Gate (auto open → close → read-back verify)

`runGated`: ran=true, **gate_closed_verified=true**, `real_api_calls` now **false** (read back
from `policy.yaml`). Claude Code never flips the gate; `runGated` does, and verifies the close.

## Cleanup

No docker residue: the per-run `--internal` network and proxy container were torn down
(`teardownEgress`); `docker network ls` / `docker ps -a` show none.

## Conclusion & next step

- **Claude honors `HTTPS_PROXY` on the hardened `--internal` cage.** proxy.log non-empty +
  story completed ⟹ Claude's egress went through the proxy. No transparent/iptables redirect is
  needed.
- **Both layers are now real, enforced, and compatible with a running Claude:** Layer 1
  (no-gateway internal net + allowlist proxy = only egress, proven 4/4) AND Layer 2 (cage has no
  secrets, proven 4/4) — and Claude still runs and completes a gated story through them.
- **The spawn-CLI architecture is viable.** Foundation confirmed; safe to build on.
- **Next:** expand to a second CLI (Codex) or a 20+ story large project — each as a single
  controlled variable, reusing this exact hardened cage + broker-token + dual-gate path.

---

### Run artifacts
`/data/python/codeharness_eval_output/cli_mode_claude_proxy_verify_20260620_202810/`
— `proxy.log` (3× anthropic CONNECT), `summary.json`, `claude-stream.jsonl`,
`delegation.diff`. Harness: `scripts/cli-mode-e2e/gated-claude-run.ts` (hardened path, run#11
config). Boundary re-proven zero-cost this session: `prove-egress.ts` 4/4.
