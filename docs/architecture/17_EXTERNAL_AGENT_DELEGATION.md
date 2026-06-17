# External-Agent Delegation — Headless-First, Sandbox-In, Gate-Out

**Status:** design baseline for EPIC-033 (revised after the integration research) ·
**Layer:** product docs (architecture)
**Depends on:** EPIC-003 (workspace/container), EPIC-030 (assessment), EPIC-032
(model registry; external CLI tools register as `kind: cli`)
**Supersedes:** the ACP-first framing of the prior 17_ACP doc.
**Risk:** HIGH — introduces a self-executing external agent. Story 1 is a SPIKE.

## What the research changed

The original plan assumed ACP (Agent Client Protocol) was the primary way to drive
Claude Code / Codex / Gemini. The investigation showed the opposite:

- **Only Gemini CLI speaks ACP natively.** Claude Code and Codex CLI do **not** —
  each needs a third-party adapter (`claude-agent-acp`, `codex-acp`) that is still
  fast-moving and prone to breaking changes. Anthropic has not formally adopted ACP.
- **Every CLI has an official, more mature headless/SDK mode**: Claude
  `claude -p --output-format json` + Claude Agent SDK; Codex `codex exec --json`
  (+ `--output-schema`) / App Server; Gemini `gemini --output-format json`.
- **Headless fits sandbox-in/gate-out perfectly**: each CLI runs one-shot,
  non-interactive, emits structured JSON, edits a working dir → we `git diff` and
  re-validate. Open-source prior art already does exactly this (e.g. a Claude Code
  plugin running in rootless Podman).

**Decision:** delegation is **headless/SDK-first**; **ACP is an optional secondary
driver** (worthwhile later for a uniform streaming/permission event surface across
agents, once adapters settle). The sandbox and the gates do not depend on which
driver is used — they are the architectural core.

## The (B) model is unchanged — only the driver changes

> **Sandbox-in, gate-out.** The external agent runs autonomously inside a
> disposable, network-restricted, isolated sandbox. Inside, we lose per-action
> gating. Outside, nothing skips the gate: the sandbox's diff is taken as an
> UNTRUSTED patch proposal and passes the full write-set + spec + validator +
> regression + Assessor pipeline.

```
        ┌──────────── ENTRY GATE ────────────┐
        │ task packet in · sandbox scope set  │
        │ (network allowlist, RO repo copy)   │
        │ budget + wall-clock cap             │
        └──────────────────┬──────────────────┘
                           ▼
        ┌────────── SANDBOX (autonomous) ──────────┐
        │ external CLI in HEADLESS mode:            │
        │   claude -p --output-format stream-json   │
        │   codex exec --json [--output-schema]     │
        │   gemini --output-format json             │
        │ (optional ACP driver for Gemini-native /  │
        │  adapter-backed Claude/Codex)             │
        │ structured JSON stream → trace + ticker   │  (observable)
        └──────────────────┬────────────────────────┘
                           ▼
        ┌──────────── EXIT GATE (the crux) ──────────┐
        │ git diff(sandbox) vs PRE-delegation state   │
        │ → untrusted patch proposal                  │
        │ write-set check: changed files ⊆ allowed?   │
        │ spec gate · validator · regression · Assessor│
        │ REJECT if it touched anything out of bounds  │
        └──────────────────────────────────────────────┘
```

The **exit gate is the security crux** (unchanged): every change the sandbox
produced must pass the write-set check, zero exceptions, diffed against the
pre-delegation tree (guards in-sandbox git tampering).

## Driver abstraction (the key new design)

A single `ExternalAgentDriver` interface with two implementations, so the sandbox
and gates are driver-agnostic:

```
interface ExternalAgentDriver {
  run(taskPacket, sandbox): AsyncStream<AgentEvent>   // emits thinking/tool/diff events
  // completion yields control; the diff is read from the sandbox by the exit gate
}
```

- **HeadlessDriver (primary)** — spawns the CLI in non-interactive mode, parses its
  structured JSON (stream-json / json-lines) into `AgentEvent`s. Per-tool wiring:
  Claude (`-p`, `--output-format stream-json`, `--bare`, `ANTHROPIC_API_KEY`),
  Codex (`exec --json`, `--output-schema`, `--ephemeral`, `CODEX_API_KEY`), Gemini
  (`--output-format json`, headless auth). This is what 033.2 builds.
- **AcpDriver (secondary, optional)** — an ACP client (TS/Rust SDK) connecting
  Gemini natively (`--experimental-acp`) or Claude/Codex via adapter. Same
  `AgentEvent` output. Deferred to a later, optional story; carries adapter-churn
  risk and ACP's documented limits (no checkpoint/history-resume, PTY quirks).

Both feed the **same** entry gate, sandbox, exit gate, and trace mapping. Choosing
a driver is a model-registry property (EPIC-032 `kind: cli` → `driver: headless|acp`),
not an architectural fork.

## Delegation result contract (diff is authoritative, agent output is advisory)

Headless mode raises a format question with a safety-relevant answer. Two formats
must not be conflated:

- **Transport format** (the CLI's own JSON: Claude stream-json, Codex json-lines,
  Gemini json) — vendor-defined, different per CLI. We cannot dictate it; the
  HeadlessDriver parses each into uniform `AgentEvent`s.
- **Delegation result** (what GateLoop consumes at the exit gate) — this we
  define, as `specs/delegation_result.schema.json`.

The crucial principle: **the source of truth is `git diff`, not the agent's
self-report.** A headless agent may *claim* it changed only `a.ts`; the worktree
diff is what actually happened. So the unified result separates authority levels:

```
delegation_result:
  diff:            <git diff vs pre-delegation tree>   # AUTHORITATIVE — gated
  stop_reason:     end_turn | cancelled | error
  tokens:          { input, output }                    # for cost
  claimed_changes: [paths...]   # OPTIONAL, agent self-report — advisory only
  agent_self_report: { ... }    # OPTIONAL — for diagnosis, never gated
```

| Source | Format | Trust | Use |
| --- | --- | --- | --- |
| `git diff` worktree | ours (a diff) | **authoritative** | the exit gate (write-set/spec/validator/Assessor) |
| CLI transport JSON | vendor-defined | reference | parsed to AgentEvents → trace / thinking ticker |
| agent self-report | mixed (see below) | reference | agent's claim/self-eval — diagnosis only |

**Lie detection, not lie trust:** if `claimed_changes` ≠ the actual diff file
set, that is NOT a gate failure (the diff is still what gets gated) — it is
recorded as a trace warning ("agent under-reported its changes"), useful signal
about the agent's honesty. The gate verdict always derives from the diff.

**Acquiring the self-report (mixed strategy):** where a CLI offers native
structured output, use it — the tool guarantees schema conformance. The SPIKE
(STORY-033.1) confirmed against real binaries that **both Codex (`--output-schema
schema.json`) and Claude (`--json-schema <schema>`, new in 2.1.x) provide native
schema-constrained output** — so the native-schema path covers Claude *and* Codex,
not Codex alone. **Gemini** has no equivalent, so for it we prompt for the shape and
**validate on receipt**, dropping/flagging a non-conforming self-report rather than
trusting it. Either way the self-report is advisory; a missing or malformed
self-report never blocks the gate, because the diff is authoritative.

The HeadlessDriver (and later the AcpDriver) both emit this same
`delegation_result`, so the exit gate consumes one fixed shape regardless of which
CLI or driver produced it.

## Algorithms (unchanged from the safety standpoint)

- **Diff extraction & write-set enforcement** (set op): `changed = git diff
  --name-only` against the recorded pre-delegation tree; assert `changed ⊆
  allowed_write_set`; any element outside → reject whole proposal → escalation.
- **Network isolation**: default-deny; allow only package registries (npm/pip) so
  the agent can install deps but cannot reach secrets or external APIs.
- **Budget / timeout**: wall-clock kill + per-delegation cost cap on the cost bar;
  a self-driving agent with no cap can spend without bound.

## Per-CLI headless notes (from the research, to verify in the spike)

- **Claude Code** (verified 2.1.178): `claude -p`, `--output-format text|json|stream-json`,
  `--bare` for scripted runs (skips hooks/skills/MCP/keychain, needs `ANTHROPIC_API_KEY`);
  `--json-schema <schema>` (native structured output — see result contract above);
  `--max-budget-usd <amount>` (native cost cap — use as a defense-in-depth *inner* cap
  inside the entry-gate budget of STORY-033.4, not as a replacement for the gate);
  permission modes incl. `bypassPermissions` — used ONLY because the container is
  the real boundary. Claude Agent SDK (TS/Python) is the most robust path.
- **Codex CLI** (verified 0.136.0): `codex exec --json`, `--output-schema schema.json`,
  `-o/--output-last-message <FILE>`, `codex exec resume`, `--ephemeral`,
  `-s/--sandbox read-only|workspace-write|danger-full-access`; sandboxed by default
  (network off, `.git` read-only). App Server (JSON-RPC, with `generate-json-schema`/
  `generate-ts`) is an alternative for rich session semantics.
- **Gemini CLI** (verified 0.15.0): positional prompt + `--output-format text|json|stream-json`
  (`stream-json` now available too), `--yolo` (isolated only); native ACP via
  `--experimental-acp` — the only CLI with native ACP. ⚠ Verify the rumored "Antigravity
  CLI" transition for unpaid tiers before depending on Gemini (unverifiable from the
  binary; 0.15.0 ships all modes intact, no deprecation notice).

**Resume is a headless capability, not a limitation:** the SPIKE confirmed all three
CLIs support headless session resume (`claude -r/--resume` + `--session-id`,
`codex exec resume`, `gemini --resume`). The "no checkpoint/history-resume" caveat
listed under the AcpDriver below is an **ACP-path** limit only — it does not apply to
the primary HeadlessDriver. Full SPIKE findings: `external_references/EPIC-033_SPIKE_HEADLESS_ACP_FINDINGS.md`.

## Risks
- **Spike must verify the research** — the integration findings are partly from
  secondary sources (dates, version numbers, the Gemini→Antigravity rumor). The
  spike confirms headless flags and JSON shapes against real binaries before build.
- **Sandbox escape / in-sandbox git tampering / cost runaway** — same mitigations
  as before (RO repo copy, no host network, ephemeral, diff vs pre-state, caps).
- **Adapter churn (ACP path)** — contained by making ACP the optional secondary
  driver, not the primary.

## Story shape (revised: headless-first, result-contract bridge, ACP optional/last)

1. **SPIKE** — verify headless modes AND ACP against real binaries; capture JSON
   shapes + flags; confirm headless-first.
2. **HeadlessDriver** — spawn CLI headless, parse structured JSON → AgentEvents
   (mock-backed, CI-safe).
3. Hardened delegation sandbox (network-restricted, RO repo copy, ephemeral).
4. Entry gate: packet → sandbox scope + budget + timeout.
5. **Delegation result contract** — `delegation_result.schema.json` (diff
   authoritative; agent self-report advisory, mixed native-schema/validated);
   per-CLI result adapters; lie-detection warning when claim ≠ diff. The bridge
   between driver and exit gate.
6. **Exit gate** — consumes the result contract: sandbox diff → untrusted patch →
   full write-set/spec/validator/regression/Assessor. Dedicated invariant test.
7. Event stream (headless JSON) → trace + thinking ticker (observability).
8. `kind: cli` (driver: headless) in the model registry (EPIC-032) + frontend.
9. Gated E2E: delegate one trivial story to a real CLI headless; prove
   sandbox-in/gate-out behind real_api_calls + opt-in.
10. **(Optional, later) AcpDriver** — secondary driver; same result contract,
    same gates; behind the same E2E.
