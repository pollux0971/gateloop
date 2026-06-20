# ADR-19 — Migrate the external builder from spawn-CLI to the Claude Agent SDK

**Status:** Proposed — investigation/design only. No code changed; the dead-code list in §5
is a *proposal awaiting human confirmation* (deletion is a boundary-crossing big move).
**Date:** 2026-06-20 · **Supersedes the execution form of:** ADR-17 (External-Agent
Delegation), ADR-18 (Dual-Mode Builder) — their *contracts* survive; their *spawn-CLI
mechanism* is replaced. **Cost of this work:** zero (pure design; `real_api_calls=false`;
nothing installed or spawned).

---

## 1. Context & decision

### 1.1 What EPIC-034 proved, and at what cost
EPIC-034 fully proved that spawning the **real Claude Code CLI binary** inside an OS cage
works end-to-end:
- a real autonomous CLI built a story inside a Docker cage and its diff passed the exit gate;
- Layer-2 (cage has no secrets) held, proven on a real process;
- Layer-1 (egress) was first *bypassed* (proxy.log empty — "set ≠ effective"), then **hardened**
  to a no-gateway `--internal` net where the allowlist proxy is the only egress, proven 4/4;
- run#13 (2026-06-20) confirmed real Claude **honors `HTTPS_PROXY`** in that hardened cage.

It works — but the cost was high and the surface fragile: a conceptual sandbox that had to be
upgraded to a real OS cage; rootless `bwrap` unusable on this host (fell back to Docker); OAuth
token injection into the cage env; a Go CONNECT proxy + `--internal` network we had to *prove*
was effective; per-CLI argv and stdout-stream-json parsing calibrated against a moving binary.

### 1.2 The trigger: opencode + the Agent SDK
`opencode` (a mature open-source agent that talks to model backends **directly**, with clean
provider / auth / schema abstractions) showed there is a less brittle path: **don't spawn a CLI
binary at all — embed the agent loop in-process.** Anthropic ships exactly that:
**`@anthropic-ai/claude-agent-sdk`** — the Claude agentic loop as a Node library, with
first-class `allowedTools`, in-process MCP tools, `canUseTool` permissions, and Pre/PostToolUse
hooks.

### 1.3 Decision
**Adopt the Claude Agent SDK as the external builder. Stop spawning the `claude` CLI binary.**
The SDK becomes a new implementation behind GateLoop's *existing* seam — it is **just another
`DiffProducer` / `ExternalAgentDriver`** (ADR-18's whole point: "a mode is just a DiffProducer;
whatever produces the diff, the diff is an untrusted artifact through the SAME shared path").
Everything trust-bearing downstream of the diff is **inherited unchanged**. The spawn-CLI cage,
controlled-bash bridge, per-CLI argv, and the egress proxy *as a per-delegation mechanism*
become dead code (the egress-proxy *pattern* and the cage *discipline* transform up a level —
see §3–§4).

### 1.4 Why this is a small change, structurally
The seam already exists and was built driver-agnostic from day one:

```
packet ─▶ DiffProducer.produce() ─▶ diff (UNTRUSTED, authoritative)
                                      │
                  ┌───────────────────┴── runExitGate (write-set crux, validator,
                  │                         regression, assessor) — MODE-AGNOSTIC
                  └── decideDelegationOutcome ─▶ action            — MODE-AGNOSTIC
```

`packages/external-agent/src/index.ts` already routes `agent_mode` and `cli_mode` through
**one** `runBuilderMode` → `runExitGate` → `decideDelegationOutcome`. The SDK slots in as the
producer; not a line of the gate changes.

---

## 2. How the Agent SDK connects to the harness

(Facts from the official docs — code.claude.com/docs/en/agent-sdk {overview, typescript,
permissions, hooks, mcp, custom-tools, secure-deployment}. Field names are real; behavior is
current as of 2026-06.)

### 2.1 Core API — embed the loop, don't parse a binary
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const message of query({ prompt, options })) {
  // SDKMessage: system/init · assistant (with tool_use) · user/tool_result · result
}
```
`query()` runs the **full agentic loop internally** (model → tool → repeat) and yields a typed
`AsyncGenerator<SDKMessage>`. **No subprocess, no stdout parsing, no argv calibration.** This
deletes `buildHeadlessCommand` + the per-CLI line parsers outright.

### 2.2 Tool layer — expose only GateLoop's high-level tools, deny Bash
Wrap the harness's tool-interface as an **in-process SDK MCP server** and remove the built-ins:
```ts
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
const gateloopTools = createSdkMcpServer({ name: "gateloop", version: "1", tools: [/* tool(...) */] });
options = {
  mcpServers: { gateloop: gateloopTools },
  allowedTools: ["mcp__gateloop__*"],
  disallowedTools: ["Bash"],   // bare name ⇒ Bash removed from context entirely
  // or tools: [] to strip ALL built-ins, then allow only mcp__gateloop__*
};
```
This is the SDK-native expression of GateLoop's **Permission-before-apply** + ACI tool surface:
the model literally cannot see Bash; it acts only through our governed tools.

### 2.3 Permissions — `canUseTool` ⇄ Permission Gateway
`permissionMode` ∈ {`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`}
plus a programmatic callback:
```ts
canUseTool: async (toolName, input, ctx) => /* allow | deny */;
```
This maps **directly** onto `packages/permission-gateway` (allow/ask/deny per tool call, decided
*before* it runs). We host the Permission Gateway inside `canUseTool` — no agent self-grant.

### 2.4 Hooks — PreToolUse (deny+mutate) / PostToolUse (redact+trace) / Stop
```ts
hooks: {
  PreToolUse:  [{ matcher: "...", hooks: [async (i) => ({ hookSpecificOutput:
                 { permissionDecision: "deny"|"allow", updatedInput } })] }],
  PostToolUse: [{ matcher: "...", hooks: [async (i) => ({ hookSpecificOutput:
                 { updatedToolOutput /* redacted */, additionalContext } })] }],
  Stop:        [{ hooks: [async () => ({})] }],
}
```
- **PreToolUse** can `deny` or `updatedInput` ⇒ second enforcement point + input scrubbing.
- **PostToolUse** can `updatedToolOutput` ⇒ this is where `event-log`'s `redact()` runs so raw
  secrets never reach the model context (mirrors ADR-17's no-secret-in-trace rule).
- All hooks observe ⇒ feed the **AgentEvent** stream (cockpit/trace) without trusting it.

### 2.5 Authentication — ⚠ the one hard break
The SDK authenticates via **`ANTHROPIC_API_KEY`** (or `CLAUDE_CODE_USE_BEDROCK` /
`CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY`). **The claude.ai subscription OAuth token
is NOT supported** for SDK-built products — the docs state Anthropic does not allow third-party
products (including those built on the Agent SDK) to use claude.ai login. EPIC-034's entire
`readClaudeOAuthToken` → broker → cage-env path **does not carry over.** See §6 Open Decision 1.

The docs *recommend* a **proxy that injects the credential** outside the agent boundary (agent
makes an unauthenticated request; the proxy adds the key, enforces a domain allowlist, logs) —
which is exactly the shape of EPIC-034's allowlist proxy. So the Secret Broker stays; what it
resolves changes (API key, not OAuth token) and *where* it injects changes (an egress proxy,
not the agent's env) — Rule of Two (§3.3).

### 2.6 Events & cost — native, no parsing
`result` messages carry `usage`, **`total_cost_usd`**, `modelUsage` (per-model breakdown), and
`permission_denials`. We map `SDKMessage` → our `AgentEvent` (session/thinking/tool_call/
tool_result/completion) for the cockpit, and read cost natively instead of summing parsed tokens.

### 2.7 Security posture — SDK is a permission layer, not a sandbox
The docs are explicit: the SDK's permission layer is **not** OS isolation, and for autonomous
loops they recommend **defense-in-depth with an external sandbox** (bubblewrap / Docker
`--network none` / a credential-injecting allowlist proxy) and the **"Agents Rule of Two"** (never
hold all three of: untrusted input · external/stateful tools · direct credential access). This
*validates* the EPIC-034 cage knowledge — but relocates it from "cage each spawned CLI" to
"optionally cage the whole harness process" (§3).

---

## 3. Security-model transition

### 3.1 "Claude promises not to" vs "Claude cannot"
| | spawn-CLI (EPIC-034) | Agent SDK |
|---|---|---|
| Tool restriction | OS cage: no Bash binary reachable → **cannot** | `disallowedTools:["Bash"]` / `tools:[]` → tool absent from context → **cannot see it** (but in-process; no kernel boundary) |
| Egress | `--internal` net + allowlist proxy = only route → **cannot** reach non-allowlist | `canUseTool`/hooks + (recommended) outer proxy |
| Filesystem | only `/work` mounted → **cannot** touch host | tool-layer write-set + (recommended) outer sandbox |

The SDK's tool/permission layer is strong and *sufficient by construction* for a non-malicious
model (the tool isn't there), but it is **in-process**: a prompt-injection or model error that
found a way to execute code would not hit a kernel boundary. So:

### 3.2 "設定 ≠ 生效" continues — PROVE the SDK controls, don't trust the config
The EPIC-034 discipline (set ≠ effective; prove with a real probe) **must** carry to the SDK,
because `disallowedTools`, `canUseTool`, and hooks are *also just configuration*:
- **Prove deny-Bash actually blocks** — run a probe story that *tries* to use Bash and assert it
  is denied (no shell executes), not merely "we set disallowedTools".
- **Prove hooks actually fire** — a probe that asserts PreToolUse denied a forbidden tool and
  PostToolUse redacted a planted secret in tool output.
- **Prove the write-set crux still bites** — unchanged: the exit gate keys off the git diff.
- This is the direct heir of `prove-cage.ts` / `prove-egress.ts` / `prove-layer2.ts`: same
  method (real probe), new target (SDK tool/permission/hook layer instead of the OS cage).

### 3.3 Optional harness-level container backstop (the cage knowledge, transformed)
The OS-cage lesson does **not** die — it moves up a level. Instead of caging each spawned CLI,
optionally run **the whole harness process** in a container as the "Claude cannot" backstop
behind the SDK's "tool absent" layer. We already have `packages/container-runtime`
(`ContainerProfile`, `DEFAULT_PROFILE`, `dryRun`) to express it, and the EPIC-034
proof scripts' *method* (real probe of `--network none` + allowlist proxy) is reusable to prove
the backstop. Recommended posture: **SDK tool-layer (primary) + credential-injecting allowlist
proxy (so the agent env holds no key — Rule of Two) + optional harness container for untrusted
inputs.**

---

## 4. Asset judgment — inherit / transform / delete (per item, from the real repo)

### 4.1 INHERIT — SDK needs these unchanged
| Asset (real path) | Why it carries over |
|---|---|
| **Exit gate** `agent-delegate/src/exitGate.ts` (`runExitGate`, `ExitGateContract/Verdict`, `assertWriteSetInvariant`) | Diff-authoritative, `self_report_excluded:true`, mode-agnostic. SDK output → git diff → same gate. |
| **Result contract** `delegationResult.ts` (`DelegationResult`, `diffFileSet`) | The untrusted-diff → changed-file-set contract is producer-independent. |
| **Outcome decision** `harness-core` `decideDelegationOutcome` | Verdict → action; never reads the mode. |
| **Guardrails** `gate-control/src/index.ts` (`runGated`, `BudgetLedger`, `TokenCapGuard`, `readGate`/`setGateEnabled` read-back) | `runGated(fn)` is opaque to `fn`; an in-process SDK call gates identically to a spawned CLI. Auto open→run→close+verify and the 6/15 loud-fail defense are untouched. |
| **Workspace-first** `workspace-manager` (`createDisposableWorkspace`, `collectDiffAgainstHead`) | SDK runs against the same disposable sandbox copy; diff vs pre-delegation tree is the truth source. |
| **Secret Broker handle surface** `secret-broker` (`SecretBroker.resolve`, handle-only) | Still the single deref point; only the *resolved value* and *injection site* change (§4.2). |
| **Multi-dim router / model backend** `model-gateway` (`resolveRoute`, routing/registry, providers.yaml) | Model = configuration, not the agent's choice. Router still picks the model; SDK takes it as `options.model`. Injection point changes (CLI provider → SDK option) — essentially inherit. |
| **Observe / anti-hallucination / contract-first** (builder behavior, `gateloop/CLAUDE.md`) | Behavioral layer; independent of how the diff is produced. |
| **AgentEvent + trace** `agentTrace.ts` (`mapAgentEventToTrace`, `agentEventsToTicker`, redaction) | SDK driver emits the same `AgentEvent` shape; trace/ticker/redaction inherit. |
| **The seam** `headlessDriver.ts` types (`ExternalAgentDriver`, `AgentEvent`, `DelegationTaskPacket`, `SandboxHandle`) + `external-agent/index.ts` (`DiffProducer`, `runBuilderMode`, `toDelegationResult`) | Purpose-built driver-agnostic. SDK is a new impl behind the same interface. |

### 4.2 TRANSFORM — concept kept, form changes (SDK mechanism decides)
| Asset | Transformation |
|---|---|
| `ExternalAgentDriver` union `'headless'\|'acp'` | **Add `'sdk'`** + a new `SdkDriver` impl: `run()` calls `query()` and maps `SDKMessage`→`AgentEvent`. Interface unchanged; one new implementor. |
| `buildDelegationResult` / self-report / lie-detection (`delegationResult.ts`) | SDK yields *typed* messages + native `permission_denials`/`total_cost_usd`; the per-CLI "native vs validated-on-receipt" stdout policy simplifies. Keep diff-authoritative + claim-mismatch concept; drop per-CLI stream parsing. |
| **Secret Broker injection form** | From "broker reads `~/.claude` OAuth → docker `-e` into cage" to "broker resolves an **API key** (or Bedrock/Vertex creds) and injects via a **credential-proxy** so the SDK env holds no key." Broker stays; resolver + site change. ⚠ depends on Open Decision 1. |
| `cli_mode` concept + `BuilderMode` (`external-agent/index.ts`) | Rename to **`sdk_mode`** (or make SDK the implementation of the external-builder mode). `agent_mode` stays the fail-safe default; the external mode is now SDK-backed, not CLI-backed. |
| CLI-mode cockpit `apps/api/src/cliModeTrace.ts` + `apps/web/src/CliModeMonitor.tsx` (034.6) | Projection **inherits** (consumes `AgentEvent`); transform the **capture source** (SDK messages, not CLI stream-json) and reframe the two-layer panel: Layer-1 proxy → optional harness-level; Layer-2 "cage has no secrets" → "agent env has no key; proxy injects" + "deny-Bash/hooks proven". |
| OS-cage knowledge `osCage.ts` + egress proxy | **Pattern** transforms up a level to the optional harness container + credential-injecting allowlist proxy (§3.3), expressed via `container-runtime`. The per-delegation *modules* are dead (§4.3). |
| EPIC-034 proof scripts' **method** | `prove-*.ts`'s real-probe discipline is reused to prove the SDK tool/permission/hook layer and the optional backstop (§3.2). The scripts as-written (targeting the CLI cage) are dead (§4.3). |

### 4.3 DELETE candidates — spawn-CLI specific (LIST ONLY; see §5, human-confirm before deleting)
These exist only because we spawned a binary and gave it a real shell + network. The SDK has no
binary, denies Bash, and controls egress at the tool/proxy layer, so they have no consumer:

**Modules / source (+ their tests):**
- `packages/external-agent/src/osCage.ts`, `osCage.test.ts` — Docker argv to cage a spawned CLI.
- `packages/external-agent/src/controlledBash.ts`, `controlledBash.test.ts` — governed shell for a CLI (SDK denies Bash).
- `packages/external-agent/src/isolation.ts`, `isolation.test.ts` — real-process escape proofs for a spawned bash (no escaping process under SDK; discipline transforms, assertions don't).
- `packages/agent-delegate/src/headlessDriver.ts` — `buildHeadlessCommand` + per-CLI argv + per-CLI stdout line parsers + the `HeadlessDriver` impl. **Keep the TYPES** (`ExternalAgentDriver`, `AgentEvent`, `DelegationTaskPacket`, `SandboxHandle`, `CliKind`) — split them out before deleting the spawning impl.
- `packages/agent-delegate/src/acpDriver.ts`, test — ACP transport for external CLIs (SDK replaces external transport).
- network/container policy in `delegationSandbox.ts` (`DELEGATION_NETWORK_POLICY`, `DELEGATION_CONTAINER_PROFILE`, sandbox-reach/proxy bits) — per-delegation egress for a spawned CLI. (Keep `looksLikeSecretPath` / `buildSandboxEnv` if still referenced.)

**Scripts / proofs / images (`gateloop/scripts/cli-mode-e2e/`):**
- `gated-claude-run.ts`, `capture-cli-mode-trace.ts` (spawn + capture the CLI),
  `prove-cage.ts`, `prove-egress.ts`, `prove-layer2.ts` (busybox cage proofs),
  `anthropic-proxy.go`, `anthropic-proxy.mjs`, `build-proxy-image.sh`, `build-cage-image.sh`,
  `build-claude-cage-image.sh`,
  `CAGE_ISOLATION_PROOF.md`, `CLI_MODE_AUTH_INVESTIGATION.md`, `CLI_MODE_E2E_REPORT.md`,
  `CLAUDE_PROXY_VERIFY_REPORT.md`.
- Docker images: `cage-claude:latest`, `cage-proxy:latest`, `cage-probe:latest`.
- ⚠ **Preserve as record** the *findings* (esp. "set ≠ effective" + claude-honors-proxy) — they
  justify the harness-level proxy in §3.3. Archive into this ADR / decision_log rather than lose.

**Conditional (depends on Open Decision 1):**
- `secret-broker` `readClaudeOAuthToken` + `ClaudeOAuthResolution` — **dead iff** we go SDK-only
  with API-key/Bedrock auth (SDK can't use the subscription OAuth token). Keep only if a CLI path
  is deliberately retained.

**Connected test/CI removals:** the four `*.test.ts` above, the `cli-mode-e2e` proof runs, and
the `cliModeMonitor` panel assertions that reference the CLI cage (reframe, not just delete).

**EPIC-034 commit output that becomes dead** (for the cleanup PR — list, not action):
034.3 controlled-bash bridge · 034.4 isolation proofs · 034.5 osCage + proxy + gated-run (incl.
the hardening + claude-honors-proxy follow-up) · the CLI-specific half of 034.6. **Inherited from
034:** 034.2's `DiffProducer`/`runBuilderMode` abstraction and the driver *interface* — these are
the foundation the SDK plugs into, not dead.

---

## 5. EPIC-035 — redefinition

**Before (old EPIC-035):** "spawn Codex into the OS cage" — extend the spawn-CLI cage to a second
CLI and a 20+ story project.

**After (this ADR):** **"Embed the Claude Agent SDK as the external builder."**
1. **SdkDriver** — new `ExternalAgentDriver` (`driver:'sdk'`): `query()` → map `SDKMessage`→`AgentEvent`; inherit diff→exitGate→decideDelegationOutcome via `runBuilderMode`.
2. **Tool surface** — wrap `tool-interface`/`tool-executor` as an in-process SDK MCP server; `disallowedTools:["Bash"]` (or `tools:[]`); `allowedTools:["mcp__gateloop__*"]`.
3. **Permissions** — host `permission-gateway` inside `canUseTool` (allow/ask/deny per call).
4. **Hooks** — PreToolUse (deny + `updatedInput`), PostToolUse (`event-log.redact` via `updatedToolOutput` + trace), Stop (checkpoint).
5. **Auth** — broker resolves an **API key** (Decision 1) and injects via a credential proxy so the SDK env holds no key (Rule of Two).
6. **PROVE it (設定≠生效)** — probe stories that assert deny-Bash blocks, hooks fire/redact, write-set crux bites; reuse the `prove-*` method against the SDK layer.
7. **Gated real run** — under `runGated` + `BudgetLedger`, run a trivial story (slugify-class) end-to-end; confirm diff gated + gate auto-closed + cost from native `total_cost_usd`.
8. **Optional backstop** — wrap the harness in `container-runtime` for untrusted inputs (§3.3).
9. **Cleanup PR (separate, human-confirmed)** — delete §4.3 after the SDK path is green; bundle-backup first.

**Then (EPIC-036+):** Codex / others via the Agent SDK's provider config or an OpenAI-compatible /
ACP compatibility layer — each as a single controlled variable on this inherited foundation.

---

## 6. Open decisions (human gate — this ADR surfaces them; does not resolve)

1. **Auth & billing (biggest).** The SDK cannot use the claude.ai **subscription OAuth** token
   that EPIC-034 relied on. Options: (a) **`ANTHROPIC_API_KEY`** — metered pay-per-token, simplest,
   loses subscription billing; (b) **Bedrock/Vertex/Foundry** — if an enterprise account exists;
   (c) retain a thin CLI path *only* for subscription-billed runs (keeps `readClaudeOAuthToken`
   alive, contradicts a clean migration). Recommendation: **(a)** for the build, revisit (b) for
   scale. This decides whether `readClaudeOAuthToken` is deleted (§4.3 conditional).
2. **Harness-level container backstop — now or later?** Ship the SDK tool-layer first and add the
   `container-runtime` backstop when untrusted inputs enter, or build both up front. Recommend:
   tool-layer + credential proxy first; container backstop before any untrusted-input story.
3. **`cli_mode` rename.** `cli_mode → sdk_mode`, or keep the name with SDK as its implementation.
   Recommend: rename to `sdk_mode` (honest) while keeping `agent_mode` the fail-safe default.
4. **Scope/timing of the §4.3 deletion.** Confirm the file list, then bundle-backup the outer repo
   and delete in a dedicated PR after the SDK path is proven green (never delete a working
   boundary before its replacement is proven).

---

## 7. opencode lessons worth borrowing
- **Provider / auth / schema separation.** opencode keeps a clean Provider abstraction (per-provider
  auth + request/response transform + a models schema). GateLoop's `model-gateway`
  (providers.yaml, model_routing.yaml, registry validation) already mirrors this — keep it as the
  provider seam, and for "Codex/others later" add an opencode-style provider adapter or an
  OpenAI-compatible shim rather than re-spawning binaries.
- **Direct-backend over binary-spawn** is the core lesson opencode demonstrates and the SDK
  embodies — fewer moving parts, typed events, programmatic control.
- **Auth as a first-class, provider-agnostic concern** reinforces routing credential resolution
  through the Secret Broker behind a single interface (and, per the SDK security docs, behind a
  credential-injecting proxy so the agent never holds the key).

---

## 8. Consequences
**Positive:** deletes the most fragile surface (cage, controlled-bash, per-CLI argv/stream
parsing, the bypassable-then-hardened proxy *as a per-delegation mechanism*); typed events +
native cost; programmatic permissions/hooks that map 1:1 onto GateLoop's gateway and redaction;
the exit gate, guardrails, router, workspace-first, and Observe layers are reused verbatim.
**Negative / risk:** loses subscription billing (Decision 1); the SDK security boundary is
in-process, so the "設定≠生效" proof burden moves to the tool/permission/hook layer and an optional
container backstop is needed for untrusted inputs; a one-time migration of the driver + tool
surface. **Net:** smaller, less brittle architecture on the *same* trust contracts — provided the
SDK controls are **proven effective**, not merely configured.
