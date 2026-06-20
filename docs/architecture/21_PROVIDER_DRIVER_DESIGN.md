# Design-21 — Provider-Driver layer (STORY-035.1 SPIKE) — in-process multi-backend behind the seam

**Status:** Design/SPIKE only (no production wiring). Implements the design called for by
[ADR-020](./20_SUBSCRIPTION_BACKENDS_OPENCODE_STYLE.md) (which supersedes ADR-019's Agent-SDK
auth/driver axis). This doc is the contract the rest of EPIC-035 builds from: 035.2 (metered-key
core driver), 035.3 (tool-layer confinement), 035.4 (PROVE set≠effective), 035.5 (gated metered
E2E), 035.6 (optional subscription), 035.7 (cleanup). **Zero cost; no AI SDK installed/run.**

---

## 1. The seam — where the ProviderDriver meets the core (behavior #1)

EPIC-033/034 already built the only integration point we need. `ExternalAgentDriver`
(`packages/agent-delegate/src/headlessDriver.ts`) and the `DiffProducer` abstraction
(`packages/external-agent/src/index.ts`) are **driver-agnostic by construction**:

```
DelegationTaskPacket ─▶ ExternalAgentDriver.run(packet, sandbox): AsyncIterable<AgentEvent>
                          │  (new impl: ProviderDriver — in-process, no spawned binary)
                          ▼
   AgentEvent stream  +  authoritative git diff
                          │
   DiffProducer.produce ─▶ ProducedDiff ─▶ toDelegationResult ─▶ runBuilderMode
                          │
   runExitGate (write-set crux · spec · validator · regression · Assessor)  — UNCHANGED
   decideDelegationOutcome ─▶ action                                          — UNCHANGED
```

**The ProviderDriver is a third `ExternalAgentDriver` implementation** alongside `HeadlessDriver`
(spawn) and `AcpDriver`. It adds `driver: 'provider'` to the union. Its `run()` drives a backend
**in-process** and yields the SAME `AgentEvent` shape; everything downstream of the diff is
inherited verbatim. New package: `packages/provider-driver/`. The `cliModeProducer` pattern
(`external-agent/index.ts`) is reused — a `providerModeProducer(driver, getDiff)` that consumes
the driver's events and reads `git diff` from the sandbox.

**Seam contract (already defined, do not change):**
- `DelegationTaskPacket { prompt, allowed_write_set, output_schema_path?, max_budget_usd? }`
- `SandboxHandle { cwd, env?, sandbox_mode?, signal? }`
- `AgentEvent { cli, kind, summary, tool?, path?, stop_reason?, tokens?, raw? }`
  (kinds: session · thinking · message · tool_call · tool_result · diff · completion · error · unknown)
- `ExternalAgentDriver { readonly driver; run(packet, sandbox): AsyncIterable<AgentEvent> }`

`CliKind` (`'claude'|'codex'|'gemini'`) is repurposed/renamed as the **backend id**; 035.7
renames `cli_mode`→`provider_mode`. For 035.2 the driver tags events with the active backend id.

---

## 2. Vercel AI SDK isolation — the core NEVER imports it (behavior #2)

The agent loop is built on the Vercel AI SDK (`ai` + `@ai-sdk/*`), **but only inside the driver**.
The whole reason we left a single-vendor SDK was to avoid the core being recaptured; so:

```
packages/provider-driver/        ← the ONLY package that imports `ai` / `@ai-sdk/*`
  src/
    providerDriver.ts            ← ExternalAgentDriver impl (imports the AI SDK)
    backends/
      metered.ts                 ← @ai-sdk/openai, @ai-sdk/anthropic via api keys (035.2)
      subscription/              ← detachable plugin (035.6), separate entry
    aiSdkAdapter.ts              ← maps AI-SDK stream parts ⇄ AgentEvent (the isolation membrane)
    index.ts                     ← exports ONLY the ExternalAgentDriver + factory; never re-exports `ai`

packages/harness-core, packages/agent-delegate, packages/model-gateway (router),
Observe, exit gate  ← import ExternalAgentDriver INTERFACE only; MUST NOT import `ai`/`@ai-sdk/*`
```

**Enforcement (035.2 acceptance + 035.4 invariant):** a test asserts no core package's source or
resolved dependency graph contains `ai`/`@ai-sdk/*` (grep the import graph; `provider-driver` is
the only allowed importer). If the AI SDK ever needs replacing, only `provider-driver` changes —
the seam keeps it swappable. The AI SDK's message/stream parts are translated to `AgentEvent` in
`aiSdkAdapter.ts` so nothing AI-SDK-shaped leaks across the seam.

---

## 3. Two tiers, sharply separated (behaviors #3, #5)

| | **Metered key — CORE (product default, shippable)** | **Subscription — OPTIONAL (detachable plugin)** |
|---|---|---|
| Story | 035.2 (build) + 035.5 (gated proof) | 035.6 (after the core is proven) |
| Auth | Standard `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` via **Secret Broker** | Borrowed opencode PKCE OAuth (≈80 lines, MIT), broker-wrapped |
| Backend | `api.openai.com` / `api.anthropic.com` (official, metered) | `chatgpt.com/backend-api/codex/...` (subscription) |
| ToS | Officially supported, no risk, distributable | **ToS-grey** (reuses OpenAI client_id; may be blocked); operator owns risk |
| Provisioning | broker resolves a key handle | **one-time host `gateloop login`** (only refresh is headless; agent never self-provisions) |
| Coupling | the core path | **the core MUST NOT depend on it**; remove it / break the endpoint → core unaffected |

**The endorsed default is the metered key.** Subscription is an isolated enhancement behind its own
package (`packages/subscription-auth/`, 035.6) and a feature flag; the `ProviderDriver` selects it
only when explicitly configured, and the metered backends carry zero import of subscription code.
ToS warning is documented at the package entry and in `docs/`. (behavior #5)

---

## 4. Borrowed opencode abstractions — form, not the coupled registry (behavior #4)

opencode's real shape = **AI SDK** (loop) + a **custom auth `fetch`** (subscription) + a 1975-line
Effect-coupled provider registry. We borrow the **form**, never the coupled registry:

| opencode | GateLoop target | Borrow |
|---|---|---|
| `Auth.Info` union `oauth{refresh,access,expires,accountId} \| api{key} \| wellknown{key,token}` (mode-0600 `auth.json`) | **Secret Broker** credential shape — broker holds the union; handle-only surface; mode-600 store | shape (data model) |
| per-provider `OAuthImplementation.{authorize,refresh}` + the inject/refresh `fetch` wrapper (auto-refresh, `Bearer`+account header, endpoint rewrite) | `packages/subscription-auth/` — ~80 lines of plain `fetch` (035.6), broker write-back replaces opencode's `auth.set` | **code** (MIT, plain `fetch`; strip Effect) |
| 1975-line Effect provider registry | a thin per-backend adapter in `provider-driver/backends/` | **NOT borrowed** (design our own over `model-gateway` routing) |
| AI-SDK message/stream parts | `aiSdkAdapter.ts` → `AgentEvent` | mapper (design) |
| `models.dev` catalog schema | feed `model-gateway` registry if useful | data shape only |

The **router stays `model-gateway`** (model = configuration). It picks the backend+model; the
driver resolves that backend's credential via the broker and runs it. One backend = one adapter +
one credential type = a single controlled variable.

---

## 5. Tool-layer confinement + optional container backstop (behavior #6)

The security crux changes from **"Claude *can't* (OS kernel boundary)"** to **"Claude *doesn't see*
Bash (in-process tool layer)"**. Design (built in 035.3, PROVEN in 035.4):

1. **Expose only high-level MCP tools** `mcp__gateloop__*` (inspect · read · apply_patch ·
   run_tests · git_diff · report) wrapping `packages/tool-interface`; **deny Bash** —
   `disallowedTools:["Bash"]` / `tools:[]` so Bash is removed from the model's context entirely.
   No shell tool is ever registered.
2. **Permission gateway** via the SDK's `canUseTool(toolName, input) → allow|deny`, hosting
   `packages/permission-gateway` 1:1 (no agent self-grant; decided before the call runs).
3. **Hooks**: `PreToolUse` (deny + validate/mutate input), `PostToolUse` (redact secrets via
   `event-log.redact` before the model/trace sees output + emit `AgentEvent` trace), `Stop`
   (require a report).
4. **Optional harness-level container backstop** — the EPIC-034 OS-cage knowledge lifted up: run
   the whole harness in `packages/container-runtime` (`--network none` + a **credential-injecting
   allowlist proxy** so the agent env holds no key — Rule of Two). Recommended before any
   untrusted-input story; not required for the trusted metered core.

**Discipline carried from EPIC-034 (the whole point of 035.4):** every item above is a *setting*.
"設定 ≠ 生效" — proven only by a real probe (deny-Bash truly blocks; hooks truly intercept/redact;
write-set crux truly bites), inheriting the `prove-*.ts` method with new targets. The OS-cage and
bypassed-proxy lessons are why this is a hard barrier before any spend.

---

## 6. Build order & invariants for 035.2–035.7
- **035.2** `provider-driver` (metered): AI-SDK isolated inside; broker key injection; AI-SDK→
  AgentEvent; DiffProducer; router picks model. Invariant: **core has zero AI-SDK import**.
- **035.3** tool layer: MCP-only + deny Bash + `canUseTool` + hooks. Built, not yet proven.
- **035.4 (barrier)** `assertToolLayerConfinementBarrier`: deny-Bash blocks · hooks deny+redact ·
  write-set crux REJECT_WHOLE — all held = precondition for 035.5. Zero cost (fake secret, probes).
- **035.5 (gated)** one trivial story on a metered key, full exit gate, auto-gate close+read-back.
- **035.6 (gated, optional, detachable)** subscription PKCE (broker-wrapped), ToS-flagged.
- **035.7** delete spawn-CLI dead code (ADR-020 §4.3), keep the seam/exit-gate/guardrails/router/
  Observe; repoint cockpit; `cli_mode`→`provider_mode`.

**Inherited unchanged across all of EPIC-035:** exit gate + result contract, guardrails (`runGated`
+ `BudgetLedger` + read-back), `model-gateway` router, workspace-first disposable workspace,
Observe/anti-hallucination/contract-first, `AgentEvent`+`agentTrace`. The ProviderDriver is the
only substantial new code; the trust contracts do not move.
