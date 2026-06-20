# CLI-Mode auth + egress investigation (STORY-034.5) — keeping the cage secret-free

**Date:** 2026-06-20 · **Pure investigation** — no Claude run, no spend, no network opened, no
real secret read. `real_api_calls = false`. Evidence: `claude --help`, subcommand help, and
`strings` over the claude 2.1.179 binary (program text, not credentials).

## Core question

Can real Claude Code authenticate **inside the cage without mounting `~/.claude`** (i.e. keep
Layer-2 defense — "the cage has no secrets")? **Answer: YES.** A supported env var
(`CLAUDE_CODE_OAUTH_TOKEN`) carries the subscription token, so the broker injects it via the
cage env and `~/.claude` is never mounted. No "Option C" (forced secret mount) situation.

## Investigation 1 — how Claude Code authenticates headless

Auth env vars referenced by the binary (from `strings`):

| Env var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | API-billing key (pay-per-token) |
| **`CLAUDE_CODE_OAUTH_TOKEN`** | **subscription OAuth token via env — the clean path** |
| `ANTHROPIC_AUTH_TOKEN` | bearer-token auth (alternative) |
| `ANTHROPIC_BASE_URL` | redirect the API endpoint (proxy option) |
| `ANTHROPIC_CUSTOM_HEADERS` | extra request headers |

Credential storage (what we must keep OUT — filenames only, contents never read):
`~/.claude/.credentials.json` (mode 600 — the subscription/OAuth credential) and
`~/.claude.json` (110 KB config). **Neither is mounted into the cage.**

Subcommands: `claude setup-token` — *"Set up a long-lived authentication token (requires Claude
subscription)"*; `claude auth login/logout/status`.

**Key nuance — `--bare`:** 033's `buildHeadlessCommand` uses `--bare`, whose help says *"Anthropic
auth is strictly `ANTHROPIC_API_KEY` or apiKeyHelper via --settings (OAuth and keychain are never
read)."* So **`--bare` likely ignores `CLAUDE_CODE_OAUTH_TOKEN`** (it's an OAuth token). For
subscription auth we therefore **drop `--bare`** and run standard headless
(`--print --output-format stream-json --permission-mode …`) with `CLAUDE_CODE_OAUTH_TOKEN` in the
env. (To be confirmed once the token is provisioned — I cannot test auth without it.)

## Investigation 2 — network requirement of auth

`CLAUDE_CODE_OAUTH_TOKEN` is a **long-lived bearer token created offline** by `claude
setup-token`. It is sent directly with each model request — there is **no separate auth
handshake/network**. So auth itself needs **no extra egress** beyond the model API call.

Hosts the binary references: `api.anthropic.com` (model — required), plus
`statsig*`/`status`/`support`/`docs`/`www`/`mcp-proxy`/`api-staging` `.anthropic.com` (telemetry
& ancillary — NOT required to run a story). Proxy is supported: **`HTTP_PROXY` / `HTTPS_PROXY`**
are referenced. Non-essential traffic can be turned off:
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` + `DISABLE_TELEMETRY` (and `DISABLE_AUTOUPDATER`).
→ With those set, **the only host needed is `api.anthropic.com`.**

## Investigation 3 — keep-the-cage-secret-free options

- **Option A (BEST — viable, keeps isolation):** inject `CLAUDE_CODE_OAUTH_TOKEN` via the broker
  subprocess into the cage env (`-e CLAUDE_CODE_OAUTH_TOKEN=<value>`). **No `~/.claude` mount;
  the cage stays secret-free (Layer 2 held).** The user runs `claude setup-token` once on the
  host (interactive subscription login), captures the token, and puts it in the broker env file
  — I never see the value (broker injects). **This is the recommended path** and matches your
  chosen `CLAUDE_CODE_OAUTH_TOKEN`.
- **Option B (fallback):** if a file were required, the broker could write the minimal token
  into the cage's ephemeral `/tmp` (broker-provided, discarded with `--rm`) — never the host
  `~/.claude`. Not needed, since Option A works via pure env.
- **Option C (would break Layer 2 — NOT triggered):** mounting host `~/.claude/.credentials.json`
  into the cage. **Avoided** — `CLAUDE_CODE_OAUTH_TOKEN` makes it unnecessary.

**Conclusion: Layer-2 defense is preserved. No secret state is mounted.**

## Investigation 4 — egress proposal (preliminary, for the next round)

Two-layer defense, both intact:

- **Layer 1 (proxy blocks "reach elsewhere"):** keep the cage `--network none` except to a
  **host-side filtering forward-proxy** the cage reaches via `HTTPS_PROXY`; the proxy's allowlist
  is **ONLY `api.anthropic.com`** (CONNECT to that host:443, everything else refused). With
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + `DISABLE_TELEMETRY=1` +
  `DISABLE_AUTOUPDATER=1`, `api.anthropic.com` is the only host Claude needs, so the allowlist is
  a single entry. Feasible because `HTTPS_PROXY` is honored.
  - *(Alternative)* `ANTHROPIC_BASE_URL` → a host-side reverse proxy that forwards only to
    `api.anthropic.com`. Similar guarantee; slightly more coupling.
- **Layer 2 (cage has no secrets):** KEPT — auth is the env token (Option A), nothing mounted.

The egress must be **re-proven** (a probe in the proxied cage can reach *only* `api.anthropic.com`
and nothing else) before any real spend — same program-gate discipline as the isolation proof.

## What's needed from you to proceed (no spend until then)

1. Run `claude setup-token` on the host (subscription login) and put the resulting token in the
   broker env file as `CLAUDE_CODE_OAUTH_TOKEN=…` (I won't read it; the broker injects it). The
   broker's `<PROVIDER>_API_KEY` convention will need a small tweak to also resolve this token
   var — I'll wire that.
2. Confirm the egress approach (filtering forward-proxy via `HTTPS_PROXY`, recommended). I'll
   then build the proxy + cage wiring, **re-prove** egress is single-host, and only then run the
   gated Claude story.

## Honest status

- `CLAUDE_CODE_OAUTH_TOKEN` makes subscription auth possible **without breaking the
  cage-no-secrets defense** — the central risk you flagged is **avoided**, not compromised.
- `--bare` must be dropped for subscription (it ignores OAuth); to verify with the real token.
- Egress is feasible (proxy + single-host allowlist) and must be re-proven before spend.
- Nothing run, nothing spent, no network opened, no secret read. Stopping for your decision.
