# 034.5 Stage 1–2 — Real OS cage built + isolation proven on a REAL process

**Date:** 2026-06-20 · **Status:** zero-cost stages complete; **STOP for human review before
Stage 3** (real Claude Code). No Claude spawned, no real network egress, no spend.
`real_api_calls = false`.

## Why this round exists

Last round halted 034.5 at pre-flight: the "hardened sandbox" was a temp-dir **model**, and
034.4 proved only that the harness's *own* checked-write helpers refuse escapes — which does
not bind a **real** external process (a real bash bypasses them via syscalls). This round
builds a **real, OS-enforced cage** and re-proves the four invariants against a **real probe
process** that actively tries to break out.

## The cage (Stage 1)

The host **forbids unprivileged user/network namespaces** (`bwrap` and `unshare` both fail:
`uid_map` / loopback `RTM_NEWADDR` "Operation not permitted"; `unprivileged_userns_clone=1`
but rootless mapping is denied). So isolation is enforced by the **Docker daemon** (root), not
by my unprivileged process — the allowed fallback. The image is built **offline** from the
host's static busybox (`docker import`, **no network pull**).

`buildDockerCageArgv` (pure, unit-tested) emits:

```
docker run --rm --init --network none \
  --cap-drop ALL --security-opt no-new-privileges --user <uid:gid> \
  --read-only --tmpfs /tmp:rw,nosuid,nodev \
  --volume <sandbox-copy>:/work --workdir /work \
  <image> <command>
```

- **Network:** `--network none` — no interfaces, OS-enforced.
- **Filesystem:** the **only** writable mount is the sandbox copy at `/work`. The host root,
  `$HOME`, the real repo (`/data/.../gateloop`), and every credential path are **not present**
  in the container at all. Read-only root + ephemeral `/tmp`.
- **Env:** host env **not inherited**; only broker-provisioned auth values via `-e`.
- **Privilege:** all caps dropped, `no-new-privileges`, ephemeral (`--rm`).
- **Mount guard:** `buildDockerCageArgv` **refuses** any `extraRoMounts` whose host path looks
  like a secret (`looksLikeSecretPath`) — secrets are never mounted.

## The proof (Stage 2) — a REAL process actively tries to escape

`scripts/cli-mode-e2e/prove-cage.ts` plants a **fake** secret on the host *outside* the cage,
then runs a **busybox shell probe inside the cage** that attempts every escape. Verbatim probe
output:

```
## read-host-secret
OK_UNREADABLE:/tmp/cage-host-secret-XXXX/.env
OK_UNREADABLE:/home/pollux/.ssh/id_rsa
OK_UNREADABLE:/home/pollux/.codex/auth.json
OK_UNREADABLE:/data/python/codeharness_workspace/gateloop/.env
## write-outside-work
OK_NOWRITE:/escape.txt
OK_NOWRITE:/etc/escape.txt
OK_NOWRITE:/bin/escape.txt
## write-inside-work
OK_WORK_WRITE
## network
OK_NET_DENIED:nc
OK_NET_DENIED:wget
## broker-env
OK_AUTH_PRESENT
HOME_IS=/
```

### Four invariants — HELD against a real confined process

| Invariant | Result | How proven |
|---|---|---|
| **1. Cannot read host secret** | ✅ HELD | the fake host `.env` **and** real `~/.ssh` / `~/.codex` / `gateloop/.env` paths are all `No such file` inside the cage — not mounted |
| **2. Writes confined, host untouched** | ✅ HELD | `/`, `/etc`, `/bin` writes refused (read-only root); `/work` write succeeds and lands on the host sandbox copy; host tree outside `/work` never created |
| **3. Network denied** | ✅ HELD | `nc` and `wget` egress both fail under `--network none` (no real connection made) |
| **4. Broker auth, no plaintext** | ✅ HELD | the fake key is readable in the cage **env** (auth works) but **absent from the sandbox disk** (recursive scan); host `HOME` not inherited (`HOME=/`) |

This is the upgrade from 034.4: **"our helpers refuse escapes" → "a real process cannot
escape."** The cage is real.

### vs. 034.4

034.4 invariants ran over the harness's TypeScript helpers (`writeSandboxFile`,
`sandboxCanReach`). These run over a **real OS process** in a **real container** that actively
tries syscall-level escapes. That is what a real Claude Code with a real bash would face.

## Cost / safety

Zero cost: static busybox probe, fake secret, no Claude, no real network egress (the network
attempt is *expected to fail*). `real_api_calls = false` (untouched). Validation: cage argv
unit tests 7/7 (CI-safe); proof script exit 0; full suite **1326 pass / 2 skip** (1319 + 7, no
regression); typecheck 0.

## ⛔ Pause — awaiting human OK before Stage 3

Stage 3 (real Claude Code inside this proven cage, gated via `runGated` + broker) will NOT run
until you confirm this real-process proof. Open Stage-3 item: Claude needs node + its install
mounted **read-only** into the cage (non-secret paths only, via the guarded `extraRoMounts`) so
it runs inside `--network none` with only `/work` writable — to be built and re-verified before
the gated spawn.

## Honest conclusion

The modeled cage is now a **real OS cage**, and a **real process provably cannot** read host
secrets, write outside `/work`, reach the network, or leak the auth key to disk. The bridge is
now safe to point at a real CLI **inside this cage** — pending your review and the Stage-3
runtime mounting.
