# CLI-Mode E2E (STORY-034.5) — HALTED at pre-flight: isolation is modeled, not enforced

**Date:** 2026-06-20 · **Status:** STOPPED before any spend or spawn. **No money spent,
no process launched, `real_api_calls = false` (untouched).** This is the highest-priority
isolation finding (鐵則 5) — surfaced exactly when the irreversible ordering intends.

## TL;DR

034.5 wants to run **real Claude Code with a real bash** inside the "hardened sandbox" from
033.3 / 034.4. But that sandbox is a **temp-directory model, not an OS-level cage**. A real
autonomous CLI process **bypasses every confinement the harness built**, because the harness
only governs writes that flow through its own TypeScript. Launching real Claude Code now
would run an all-permissions-bypassed agent **as user `pollux`** with read access to real
secrets, write access to the real repo/home, and unrestricted network. That is precisely the
catastrophe the "prove isolation before spend" ordering exists to prevent — so the run was
halted.

## What 034.4 actually proved (and what it did not)

034.4's `assertSandboxIsolationBarrier` (4/4 held, `dabc955`) proved that **the harness's own
checked-write helpers refuse escapes**: `sandboxCanReach` returns false for outside paths,
`writeSandboxFile`/`readSandboxFile` throw on containment violations, the network policy is
default-deny *as data*, and `buildSandboxEnv` scrubs the env.

That is a proof about **our code's behavior**. It is **not** a proof that a **real external
process** is caged — and architecturally it cannot be, because a real `claude` process never
calls `writeSandboxFile`. It has its own real bash and writes via OS syscalls.

## Evidence (verified pre-flight, zero cost)

| Check | Result |
|---|---|
| `claude` installed / headless-capable | ✅ `2.1.179` at `/home/pollux/.local/bin/claude` |
| `real_api_calls` gate | ✅ `false` |
| 034.4 barrier invariants | ✅ 4/4 held — **but over harness helpers, not a real process** |
| `createDelegationSandbox` | ⚠️ `fs.mkdtempSync` + `fs.cpSync` — a plain temp dir. No container, namespace, mount, or net restriction. `profile`/`network`/`read_only_repo_copy` are **metadata**, enforced by nothing. |
| `container-runtime` | ⚠️ `dryRun()` / schema-only — *"Actual container execution … never actually run here. v0."* Builds a `docker …` string, never executes it. |
| 034.3 `runControlledBash` | ⚠️ Confines writes **only** by checking `isPathInsideRoot` before the harness's own `fs.writeFileSync`. Governs scripted writes routed through our code — **not** a real process. |
| Real cli-mode gated spawn entry | ❌ **Does not exist** (the prompt's `<runGated + cli_mode + claude-code>` is a placeholder for infra never built). |
| `buildHeadlessCommand` (claude) | ⚠️ Uses `--permission-mode bypassPermissions`, justified in-code by *"the container is the real boundary"* — **but there is no container.** |

## Why running now is unsafe

`nodeProcessSpawner` would `spawn('claude', ['--print','--bare', …, '--permission-mode',
'bypassPermissions'], { cwd: /tmp/ch-delegate-*, env: PATH+auth })`. The result:

- **`cwd` is not a cage.** A real bash can `cd /`, use absolute paths, follow symlinks — `cwd`
  only sets the starting directory.
- **Real secrets are readable.** The env is scrubbed, but the *files on disk* are not gated:
  `gateloop/.env` (the real provider keys), `~/.ssh`, `~/.codex/auth.json`, `~/.aws` — all
  readable by user `pollux`, i.e. by the agent.
- **The real tree is writable.** It can write to `/data/python/codeharness_workspace/…`,
  `$HOME`, anywhere the user can.
- **Network is open.** `DELEGATION_NETWORK_POLICY` is metadata; nothing enforces it. The agent
  can `curl` to exfiltrate.
- **Permissions are bypassed.** `bypassPermissions` + no cage = maximum capability, zero
  containment.

The 034.4 invariants do not catch this because the real process is **not on the code path they
test**. The crack is not in one invariant — it is that **the cage they describe is not actually
built for a real process.**

## The fix — build a REAL cage, then re-prove, then spend (ordering preserved)

The host already has the tools: **`bwrap` (bubblewrap), `docker`, and `unshare` are present.**
So a real cage is achievable without new dependencies. Required before 034.5 may run:

1. **Wrap the `claude` spawn in a real OS jail** (recommend `bwrap`):
   - `--unshare-net` (or `--unshare-all` + no net) → network genuinely default-deny;
   - bind **only** the sandbox copy writable (`--bind <sandbox> /work`, `--chdir /work`);
   - **no** bind of `$HOME`, the real repo, `gateloop/.env`, `~/.ssh`, `~/.codex`, `/etc` secrets;
   - `--die-with-parent`, `--new-session`, drop caps; pass auth only via the broker-provisioned
     child env (never a file mount).
2. **Re-prove the four invariants against a REAL process inside the jail** (still zero-cost): a
   tiny probe (not Claude) that tries to `cat` a planted fake secret, write outside `/work`, and
   `curl` a denied host — assert all three fail *from inside the bwrap jail*, and that the auth
   value is absent from the jail's filesystem. This upgrades 034.4 from "harness helpers refuse
   escapes" to "a real confined process cannot escape."
3. **Only then** run real Claude Code inside the proven jail under `runGated` + broker.

This keeps the mandatory, irreversible ordering intact: the cage is proven on a **real process**
before a **real spend**.

## Single-variable note

Unchanged intent: when it does run, it stays cli_mode · one CLI (Claude Code) · one trivial
story. The fix above is about *enforcement*, not scope.

## Honest conclusion

The minimal CLI-mode bridge (mode abstraction 034.2, controlled-bash observation/diff 034.3) is
sound **as a model**. But the **isolation enforcement** for a real autonomous bash does not yet
exist — 034.4 proved the design predicates over the harness's own helpers, not a real process.
**The bridge is not yet safe to point at a real CLI.** Patch the cage (build it, re-prove on a
real process) before continuing. Do not spend until the jail is proven on a real process.
