# 18 — Dual-Mode Builder (Agent Mode ⇄ CLI Mode, Controlled-Bash Bridge)

> ⚠️ **ADR-0013 (operator-trust) — no execution-side wall (STORY-TRUST.4 doc sweep).** GateLoop has **NO** sandbox / egress / isolation / container protection — that cage was never actually built. Any sandbox/egress/isolation/container text below is **SUPERSEDED design that does NOT describe a present protection** (leave no phantom defense). Execution runs **direct on the host**; the operator is fully trusted (risk level = running any local AI coding tool with auto-run). The one real, **KEPT** execution-side mechanism is the **tool-layer proposal-shaping (no Bash by construction)** — that is real and is NOT removed; it is not a wall. See `ADR/ADR-0013-no-sandbox-operator-trust.md` (reopen it only if ever exposed to untrusted multi-tenant use).

**Status:** design / SPIKE (STORY-034.1). No production wiring here — this document
defines the boundary, the controlled-bash bridge, the secret strategy, what is reused
from EPIC-033, and the mandatory isolation-before-spend ordering. Implementation lands
in 034.2 (mode abstraction), 034.3 (bridge), 034.4 (isolation proof, barrier), 034.5
(gated real Claude Code), 034.6 (cockpit).

**Builds on:** `17_EXTERNAL_AGENT_DELEGATION.md` (EPIC-033). This epic does **not**
rebuild 033 — it abstracts a mode switch over it and deepens its "spawn + parse JSON"
into a governed bash.

---

## 0. Why two modes

The builder already ships **agent mode**: an API model (DeepSeek/OpenAI/etc. via the
model gateway) acting **only** through the ACI tool interface (EPIC-015) — every action
is a typed tool call the Permission Gateway judges before it runs. The model never
touches a shell.

**CLI mode** integrates a full autonomous CLI agent (Claude Code first) that works inside
a real, but **caged**, bash. This is the highest-capability builder yet, and also the
highest-risk: in agent mode the model can only do what the ACI schema allows; in CLI
mode the agent can run arbitrary commands. So the bridge's first job is not "make it
work" — it is "keep it caged". The whole epic is ordered around proving the cage holds
(034.4) **before** a real CLI ever spends money (034.5).

---

## 1. Dual-mode boundary — what is SHARED vs PER-MODE

The design principle: **both modes are interchangeable producers of one untrusted
artifact — a diff — that flows through the same exit gate and the same result contract.**
Everything that establishes trust is shared; only *how the diff is produced* differs.

### 1.1 Shared (mode-agnostic — neither mode may bypass or weaken these)

| Concern | Component (reused from 033) | Why shared |
| --- | --- | --- |
| Entry gate (scope + budget + wall-clock) | `entryGate.ts` — `composeDelegation`, `DelegationScope`, `DelegationLimits`, `BudgetLedger`, `assertNonInteractive` | both modes get a bounded task packet; budget/timeout kill applies equally |
| Sandbox (ephemeral, RO repo copy, default-deny net) | `delegationSandbox.ts` — `createDelegationSandbox`, `DELEGATION_NETWORK_POLICY`, `DELEGATION_CONTAINER_PROFILE`, `sandboxCanReach` | the workspace a mode runs in is the same isolation primitive |
| Result contract (diff AUTHORITATIVE, self-report ADVISORY) | `delegationResult.ts` — `DelegationResult`, `buildDelegationResult`, `diffFileSet`, `detectClaimMismatch`, `validateDelegationResult` | the harness trusts the diff, never the agent's self-report — identical for both |
| Exit gate (untrusted diff → full pipeline) | `exitGate.ts` — `ExitGateContract`, `ExitGateGates`, `ExitGateVerdict`, `assertWriteSetInvariant`; `harness-core.decideDelegationOutcome` | write-set + spec + validator + regression + Assessor; out-of-write-set rejects the WHOLE diff |
| Trace / ticker projection | `agentTrace.ts` — `mapAgentEventToTrace`, `agentEventToTicker` | both modes emit `AgentEvent`s; the cockpit renders them uniformly (034.6) |

### 1.2 Per-mode (the only thing that differs — how the diff is produced)

| | **agent_mode** (shipped) | **cli_mode** (new) |
| --- | --- | --- |
| Actor | API model via model gateway | external CLI agent (Claude Code) |
| Action surface | ACI tool interface (typed tool calls, gateway-judged) | controlled bash inside the sandbox (034.3) |
| Driver | `producePatchProposal` (developer-runtime) | `ExternalAgentDriver` / `HeadlessDriver` (033, `headlessDriver.ts`) |
| Output | edits → diff | `AgentEvent` stream → diff vs pre-delegation tree |
| Default | **yes (fail-safe)** | opt-in per story/config |

**Boundary statement:** the mode switch sits *above the diff and below the exit gate*. A
mode is a `DiffProducer`; once it yields a diff + an `AgentEvent` stream, the path is
identical. agent_mode is the default; cli_mode is selected explicitly and, when chosen,
routes (in 034.2) to 033's `ExternalAgentDriver` as the backing driver.

```ts
// 034.2 sketch — the abstraction; NOT a new gate, just a producer selector.
export type BuilderMode = 'agent_mode' | 'cli_mode';

export interface DiffProducer {
  readonly mode: BuilderMode;
  produce(packet: DelegationTaskPacket, sandbox: SandboxHandle):
    Promise<{ diff: string; events: AgentEvent[]; selfReport?: unknown }>;
}
// agent_mode → wraps producePatchProposal; cli_mode → wraps ExternalAgentDriver (033).
// Both results go to buildDelegationResult(...) → decideDelegationOutcome(...) UNCHANGED.
```

---

## 2. Controlled-bash bridge — command mediation + observation (034.3 design)

033 today does "spawn CLI headless, parse its JSON into `AgentEvent`s". 034.3 deepens the
*bash* the CLI agent works in into a **mediated, observed, write-confined** shell. Three
mechanisms:

### 2.1 Write confinement (the cage)
- The bash's working directory is the **sandbox copy** (`DelegationSandbox.root`), a
  throwaway RO-seeded copy of the repo created by `createDelegationSandbox`. The process
  is launched with `cwd = sandbox.root` and an environment from `buildSandboxEnv(authEnv)`
  (no host paths leaked).
- Writes **cannot escape** the sandbox copy: the container/`DELEGATION_CONTAINER_PROFILE`
  (rootless, read-only root, dropped caps) mounts only the sandbox copy writable; the
  real working tree is never mounted writable. A command that targets a path outside the
  copy either fails (no mount) or writes into the disposable copy and is discarded.
- **Authority is the diff, not the filesystem claim.** Even if the agent tampers with
  in-sandbox git, the harness computes the diff **vs the pre-delegation tree snapshot**
  it captured itself (`diffFileSet`), so in-sandbox history rewriting cannot smuggle
  changes past the exit gate.

### 2.2 Command mediation
- The bridge runs the CLI agent under a recording shell so every command the agent
  executes is **captured** (argv + cwd + exit status) before/as it runs. Mediation is
  *observe-and-confine*, not *approve-each-command*: the cage (sandbox + network policy +
  write confinement) is what enforces safety, so we do not need a human in the loop for
  each command. `assertNonInteractive` guarantees the CLI is launched in a non-interactive
  headless mode (no TTY prompts that could stall or escape).

### 2.3 Observation without trust
- Each recorded command becomes an `AgentEvent` (kind e.g. `tool_use`/`command`) appended
  to the harness event stream — this is **observation for audit/cockpit**, explicitly
  **not** a trust signal.
- The bridge surfaces the CLI agent's output as an `AgentEvent` stream and, at the end, a
  **diff vs the pre-delegation tree**. The diff is the only thing the exit gate consumes;
  the recorded commands and the agent's self-report are advisory (`SelfReportSource`,
  `detectClaimMismatch` flags lies as warnings, never as a pass).

```ts
// 034.3 sketch
export interface ControlledBashBridge {
  // working dir is forced to sandbox.root; net per DELEGATION_NETWORK_POLICY; env via buildSandboxEnv.
  run(cli: CliKind, packet: DelegationTaskPacket, sandbox: SandboxHandle): Promise<{
    events: AgentEvent[];        // includes recorded commands (observation, not trust)
    diff: string;                // vs pre-delegation tree snapshot (authoritative)
    stopReason: StopReason;
  }>;
}
```
034.3 is tested with a **scripted/stub CLI** (no real Claude Code spend). The stub emits a
deterministic command sequence + a diff so the bridge's confinement, recording, and
event/diff emission are provable CI-safe.

---

## 3. Secrets stay OUTSIDE the sandbox — broker subprocess pattern (§2)

The cardinal rule: **raw secrets never enter the sandbox**, yet the CLI must authenticate
to its provider.

- The Secret Broker (`@gateloop/secret-broker`) resolves a key **outside** the sandbox via
  `subprocessEnvSource({ envFile })`: a short-lived child process sources the env file and
  prints only the value; the harness (and the agent) never `cat` the file. (Same pattern
  proven in the router eval.)
- The resolved value is injected only as the **authenticated environment** of the CLI
  process via `buildSandboxEnv(authEnv)` — and only the specific provider token the CLI
  needs, scoped to that process. It is **not** written to any file inside the sandbox copy,
  not in env dumps in the trace, not in `AgentEvent`s.
- `looksLikeSecretPath` + the network policy guard the other direction: the sandboxed bash
  **cannot read host secret files** (they are outside the RO copy and unmounted) and
  **cannot exfiltrate** (default-deny network, registry allowlist only).
- **The broker stays on the host side of the boundary.** The sandbox sees a process
  environment, never the broker, never the env file, never plaintext at rest.

This is exactly what 034.4 proves with a **fake** secret (see §5).

---

## 4. Reuse map — what 034 takes from 033 (no rebuild)

| 034 need | 033 component reused | 034 adds |
| --- | --- | --- |
| Run a CLI headless, parse to events | `headlessDriver.ts` (`ExternalAgentDriver`, `buildHeadlessCommand`, `AgentEvent`) | bash mediation + command recording (034.3) |
| Isolated workspace | `delegationSandbox.ts` (`createDelegationSandbox`, container profile, net policy) | write-confinement + isolation invariants (034.4) |
| Bounded task | `entryGate.ts` (`composeDelegation`, budget, wall-clock kill) | mode field on the packet (034.2) |
| Trust the diff, not the agent | `delegationResult.ts` (`buildDelegationResult`, `diffFileSet`, lie detection) | reused as-is |
| Gate the diff | `exitGate.ts` + `harness-core.decideDelegationOutcome` | reused as-is (shared by both modes) |
| Trace/ticker | `agentTrace.ts` | mode indicator + bash activity (034.6) |
| Gated real run | `@gateloop/gate-control` `runGated` + Secret Broker | one-CLI-one-story E2E (034.5) |

034 writes **new** code only for: the mode abstraction (034.2), the controlled-bash bridge
mechanism (034.3), the three isolation invariants (034.4), and the cockpit projection
(034.6). Everything trust-bearing is 033, unchanged.

---

## 5. Isolation proof BEFORE spend — mandatory, irreversible ordering

> A CLI agent with a real bash is the highest-capability builder. If the sandbox leaks and
> we have not proven it, a real run could expose real secrets or write outside the cage.
> Therefore the cage is proven at **zero cost** (fake secrets + dry-run) **before** a real
> CLI is ever launched. **This ordering cannot be reversed.**

**034.4 (barrier, zero-cost) must turn three isolations into tested invariants:**

1. **Secrets invisible** — `assertSandboxCannotReadHostSecret`: plant a **fake** secret /
   `.env` on the host *outside* the sandbox; assert the sandboxed bash cannot read it. The
   CLI authenticates via the broker subprocess (§3), never seeing plaintext.
2. **Writes confined** — `assertWriteOutsideSandboxBlocked`: a command attempting to write
   outside the sandbox copy fails / leaves the **real tree untouched** (verified against the
   pre-delegation snapshot).
3. **Network denied** — `assertNetworkDeniedInSandbox`: a `fetch`/network attempt inside the
   sandbox fails under `DELEGATION_NETWORK_POLICY` (default-deny; only the registry
   allowlist, which the proof does not exercise live).

The proof is **zero-cost**: the planted secret is fake, the network attempt is expected to
fail, no real CLI is spawned, nothing real is contacted. Only after all three invariants
are green (and a human confirms — see the epic barrier) may **034.5** run real Claude Code
under `runGated` (auto open → run → auto-close + read-back verify) + broker.

**Ordering (cannot be reordered):**
```
034.1 design → 034.2 mode abstraction → 034.3 bridge (stub CLI)
   → 034.4 isolation invariants (fake secret + dry-run, ZERO cost)  ── BARRIER (human OK) ──
   → 034.5 gated real Claude Code (runGated + broker)  → 034.6 cockpit
```

---

## 6. Open decisions (for 034.2+)

- **Container vs process sandbox for the bash**: 033's `DELEGATION_CONTAINER_PROFILE`
  assumes a rootless container. If the host lacks a container runtime, 034.3/034.4 fall
  back to a process-level cwd-confined shell with the same invariants asserted; the
  invariant tests must pass under whichever backing is used (decided in 034.3).
- **Command mediation depth**: observe-and-confine (chosen) vs per-command approval. We
  choose observe-and-confine because the cage, not per-command vetting, is the security
  guarantee; revisit only if a future CLI needs finer control.
- **Self-report schema per CLI**: reuse `cliUsesNativeSchema` (033) — Claude Code's native
  schema where available, else validate-on-receipt; lies warn, never fail.

This is design only. No shippable code, no tests, no real calls.
