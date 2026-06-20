# ADR-20 — opencode-style multi-backend builder on **subscription** auth (supersedes ADR-19's auth/driver axis)

**Status:** Proposed — investigation/design only. Zero cost (no install, no spawn, no real auth,
no secrets read; `real_api_calls=false`). **Relationship to ADR-19:** ADR-19 correctly chose
"direct-backend over spawn-CLI" but assumed the **Claude Agent SDK**, then found the SDK **cannot
use a claude.ai subscription** (API-key/Bedrock only). This ADR **keeps everything in ADR-19 that
is about *direct-backend vs spawn-CLI*** (asset judgment, security-model transition, the
"設定≠生效" discipline, the spawn-CLI dead-code list) and **replaces only the auth + driver axis**:
not "embed the Claude Agent SDK," but "**opencode-style multi-provider layer authenticating to
*subscription* backends** (Codex/ChatGPT subscription primary), with each provider's credential
held by our Secret Broker." **Source read (not run):** `opencode-dev.zip` → MIT-licensed.

---

## 1. FIRST PRIORITY — can we borrow opencode's subscription auth? **YES for Codex/ChatGPT, with honest caveats.**

This was the make-or-break question (don't repeat the Agent-SDK "thought it worked, it didn't"
trap). I read opencode's real auth code. Verdict: **the subscription-OAuth mechanism is portable
plain `fetch` logic, MIT-licensed, and not bound to opencode's architecture for the parts that
matter.** The caveats are real but manageable.

### 1.1 How opencode authenticates a subscription backend (Codex/ChatGPT — the exemplar)
Read from `packages/core/src/plugin/provider/openai-auth.ts` + `packages/opencode/src/plugin/openai/codex.ts`:

- **Login = standard public-client OAuth2 with PKCE (S256)** against `https://auth.openai.com`,
  client_id `app_EMoamEEZ73f0CkXaXp7hrann`, scope `openid profile email offline_access`, params
  `codex_cli_simplified_flow=true`, `originator=opencode`. **No client secret** (public client).
  Two entry modes: *browser* (spins a localhost:1455 callback server, opens the authorize URL,
  exchanges the code) and *headless device-code* (`/api/accounts/deviceauth/usercode` → poll
  `/deviceauth/token` → exchange). Login yields `{access_token, refresh_token, expires_in,
  id_token}`; the `chatgpt_account_id` is parsed from the JWT claims.
- **Storage:** `auth.json` (mode `0o600`) keyed by providerID, a discriminated union
  `oauth { refresh, access, expires, accountId } | api { key } | wellknown { key, token }`
  (`packages/opencode/src/auth/index.ts`). Overridable wholesale by `OPENCODE_AUTH_CONTENT` env.
- **Use (the crux):** a **custom `fetch` wrapper** the AI-SDK provider calls. Each request it:
  (1) strips any inbound `Authorization`; (2) if `access` missing or `expires < Date.now()`,
  **refreshes** via `grant_type=refresh_token&refresh_token&client_id` (deduped behind one
  in-flight promise) and writes the new token back to the store; (3) sets
  `Authorization: Bearer <access>` + `ChatGPT-Account-Id: <accountId>`; (4) **rewrites the URL**:
  any `/v1/responses`|`/chat/completions` is redirected to the **subscription backend**
  `https://chatgpt.com/backend-api/codex/responses` (NOT the metered `api.openai.com`). The
  AI-SDK provider is given `apiKey: OAUTH_DUMMY_KEY` so it constructs, but real auth is the fetch
  wrapper. Allowed models gate to `gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark`.

### 1.2 Can we borrow it? **Yes — it's ~80 lines of plain fetch + a one-time login.**
- The **refresh + inject-Bearer + endpoint-rewrite** logic is plain `fetch` (the Effect/plugin
  wrapper is removable). The ONLY opencode-specific couplings are: writing the refreshed token
  back via `client.auth.set` (→ replace with a **Secret Broker write**) and an optional
  websocket pool (an optimization — drop it). **Nothing about the token mechanics binds to
  opencode.** This is the opposite of the Agent-SDK wall: there the *provider* refused the
  subscription; here the subscription endpoint accepts a Bearer access token we fully control.
- **MIT-licensed** → we may copy/adapt the OAuth helpers directly.
- It maps cleanly onto GateLoop's stated default backend: `gateloop/CLAUDE.md` already says
  "Default backend is Codex via a ChatGPT subscription (OAuth), credentials in `~/.codex/auth.json`
  behind the Secret Broker." opencode shows the exact mechanism that makes that real.

### 1.3 The honest caveats (the 坑 — none fatal, all must be planned for)
1. **Login is interactive & host-side; only *refresh* is headless.** The authorize step needs a
   browser (localhost callback) or a human entering a device code — it **cannot** run unattended
   inside a cage. Plan: a **one-time human `gateloop login <provider>`** on the host produces the
   stored `{refresh, access, expires}`; thereafter the harness only needs the **refresh token**
   and refreshes non-interactively. This matches GateLoop's "human gate for secret use" and the
   existing `~/.codex/auth.json` assumption. Not a blocker — but the harness can't self-provision
   the credential.
2. **ToS / client-id gray area (the real uncertainty).** opencode reuses a Codex OAuth client_id
   with `originator=opencode`. Using a subscription-OAuth client from a third-party harness is
   **technically functional but not officially sanctioned**, and OpenAI could change or block it.
   This is *less* hostile than Anthropic (which **explicitly forbids** third-party claude.ai login
   for SDK products — ADR-19 §2.5), but it is **not a blessed integration**. Honest stance: viable
   for a personal/internal builder on the operator's own subscription; **do not** assume it is a
   stable, sanctioned, redistributable integration.
3. **Undocumented endpoint.** `chatgpt.com/backend-api/codex/responses` is internal and can change;
   we inherit opencode's maintenance burden (track their updates).
4. **Claude subscription is NOT a clean option here.** This opencode snapshot's `anthropic.ts` is
   only AI-SDK config (headers + sdk module) — **no Claude Pro/Max OAuth implementation present**,
   and the Agent-SDK ToS forbids claude.ai login anyway. ⇒ **Do not plan on a Claude subscription
   backend.** Use Codex/ChatGPT subscription as primary; Claude only via metered API key/Bedrock if
   ever needed.

**Bottom line:** the pivot is **viable** for the backend GateLoop actually wants (Codex/ChatGPT
subscription), the code is borrowable, and the failure mode is "operator-scoped, possibly-rate-
limited, endpoint may drift" — not "categorically forbidden" like the Agent-SDK route.

---

## 2. Subscription backends — which are available, which we want

| Backend | Subscription auth in opencode | Portable? | Want it? |
|---|---|---|---|
| **Codex / ChatGPT (Pro/Plus)** | PKCE OAuth (browser + headless device) → `chatgpt.com/backend-api/codex/responses` | **Yes** (plain fetch, MIT) | **Primary** (= GateLoop's default backend) |
| **GitHub Copilot** | Device-code OAuth (`github.com/login/device/code` → `/login/oauth/access_token`) → Bearer; `copilot_internal` token | **Yes** (device flow, plain fetch) | **Secondary** — good fallback subscription |
| Anthropic Claude Pro/Max | **Not present** in this snapshot (anthropic.ts = AI-SDK config only); Agent-SDK ToS forbids | n/a | **No** (use metered API key/Bedrock if ever) |
| Metered API keys (OpenAI, Anthropic, Google, xAI, Bedrock, OpenRouter, …) | `api`/`wellknown` cred types | Yes (trivial) | Available as **paid fallback**, not subscription |

**Decision:** target **Codex/ChatGPT subscription as primary**, **GitHub Copilot as the secondary
subscription fallback**; metered API keys remain a config-only paid fallback (already how
`model-gateway` thinks). Each new backend = one provider adapter + one credential type, single
controlled variable.

---

## 3. Borrowing opencode's abstractions (provider / auth / schema → GateLoop)

opencode's real architecture is **Vercel AI SDK** (`@ai-sdk/*`) for the model/agent-loop, **plus a
custom auth `fetch`** for subscription, **plus** an Effect/plugin provider registry. Map each layer:

| opencode layer | GateLoop target | Borrow code or design? |
|---|---|---|
| **Auth** — `Auth.Info` union {oauth/api/wellknown} + per-provider `OAuthImplementation.{authorize,refresh}` + the inject/refresh fetch wrapper | **Secret Broker** holds the credential (handle-only surface, already mode-600-aware); a small **refresh-on-expiry resolver** (ported `refresh()` + the fetch injector) replaces opencode's `auth.set` write-back with a broker write | **Borrow code** (MIT, ~80 lines plain fetch; strip Effect). High-value, well-bounded. |
| **Provider** — AI-SDK provider + custom fetch, registered in a big Effect provider registry (`provider.ts`, 1975 lines, deeply opencode-coupled) | A thin **`SubscriptionProviderDriver` implementing our `ExternalAgentDriver`** (ADR-17 seam): holds a broker credential, runs the agent loop via the **Vercel AI SDK** against the subscription endpoint, yields our `AgentEvent` stream + the authoritative diff | **Design our own** over the AI SDK; **borrow the shape**, not the 1975-line registry. |
| **Schema/events** — AI-SDK message/stream parts | Map AI-SDK parts → our **`AgentEvent`** (session/thinking/tool_call/tool_result/completion) — same normalization ADR-19 §2.6 planned | **Design** (tiny mapper), reuse `agentTrace`. |
| **Models catalog** — `models.dev` schema | Feed `model-gateway`'s registry (providers.yaml / model_routing.yaml) | **Borrow data shape** if useful. |

**Net architecture:** `Vercel AI SDK` (model loop + tool calling) + **borrowed subscription-auth
fetch** (Bearer-inject + refresh + endpoint-rewrite, broker-backed) wrapped as **one
`ExternalAgentDriver`** → flows through the SAME `runBuilderMode → runExitGate →
decideDelegationOutcome`. The driver is the only new code of substance; everything trust-bearing is
inherited (§4).

---

## 4. What ADR-19 still holds vs what changes

### 4.1 RETAINED from ADR-19 (direct-backend vs spawn-CLI — unaffected by the auth pivot)
- **Asset judgment — INHERIT (verbatim):** exit gate (`runExitGate`, write-set crux, self-report
  excluded), result contract (`DelegationResult`, `diffFileSet`), `decideDelegationOutcome`,
  guardrails (`runGated` + `BudgetLedger` + `TokenCapGuard` + read-back/loud-fail), workspace-first
  disposable workspace, multi-dim router / model-gateway, Observe / anti-hallucination /
  contract-first, `AgentEvent` + `agentTrace`, and **the driver seam** (`ExternalAgentDriver`,
  `DiffProducer`, `runBuilderMode`). (ADR-19 §4.1.)
- **Security-model transition (verbatim):** tool-layer "model can't see Bash" vs OS-cage "can't";
  the SDK/AI-SDK boundary is **in-process**, so an optional **harness-level container backstop**
  (`container-runtime`) + a **credential-injecting allowlist proxy** (Rule of Two — the agent env
  never holds the token; the proxy injects it) remain the recommended outer layer. **Now even more
  apt:** the subscription token must be guarded exactly like that proxy pattern. (ADR-19 §3.)
- **"設定 ≠ 生效" discipline (verbatim):** permissions/tool-deny/hooks are *config* → **prove**
  deny-Bash blocks, hooks fire/redact, write-set crux bites; reuse the `prove-*.ts` method against
  the new target. (ADR-19 §3.2.)
- **spawn-CLI dead-code list (verbatim, still LIST-ONLY, human-confirm):** `osCage`,
  `controlledBash`, `isolation`, `HeadlessDriver`/`AcpDriver` spawn impls + per-CLI argv/parsers,
  the `cli-mode-e2e/*` cage+proxy proofs & images. (ADR-19 §4.3.) Note: the egress-proxy *pattern*
  is now **re-promoted** as the §3 credential-injecting proxy — keep the *method*, delete the
  per-CLI *mechanism*.

### 4.2 CHANGED by this ADR (the auth + driver axis)
- **Auth:** ~~Claude Agent SDK with `ANTHROPIC_API_KEY`/Bedrock~~ → **opencode-style multi-provider
  subscription auth via the Secret Broker** (Codex/ChatGPT primary, Copilot secondary). Borrow the
  OAuth refresh + fetch-injection helpers (MIT); broker holds `{refresh, access, expires}`; one-time
  human login provisions it (§1.3-1).
- **Driver:** ~~a single `SdkDriver` calling `query()`~~ → **a `SubscriptionProviderDriver`** (an
  `ExternalAgentDriver`) over the **Vercel AI SDK** with the borrowed auth fetch; pluggable per
  backend (Codex, Copilot, metered keys) behind `model-gateway` routing.
- **ADR-19 §6.1 dead-end resolved:** "subscription unusable" was true *only for the Claude Agent
  SDK*. Via the opencode-style path, **Codex/ChatGPT subscription IS usable** (with §1.3 caveats).
  The blocker is lifted for the backend GateLoop actually targets.
- **Tooling surface:** the Agent SDK's in-process MCP `tool()` + `disallowedTools:["Bash"]` is no
  longer the mechanism; instead **tool calling via the AI SDK** with GateLoop's `tool-interface` as
  the only exposed tools (no shell tool registered) + `permission-gateway` gating each call. Same
  principle ("model acts only through governed high-level tools"), different host.

---

## 5. EPIC-035 — redefinition (opencode-style subscription multi-backend)

1. **`gateloop login codex`** (host, human, one-time): port opencode's PKCE/device-code helpers
   (MIT) → obtain `{refresh, access, expires, accountId}` → store via the **Secret Broker** (handle
   surface, mode-600, never in context/logs/trace).
2. **Subscription auth resolver:** broker-backed `fetch` injector — refresh-on-expiry (deduped),
   `Authorization: Bearer` + `ChatGPT-Account-Id`, endpoint-rewrite to the subscription backend.
   Token value never logged (event-log redaction).
3. **`SubscriptionProviderDriver`** (`ExternalAgentDriver`): Vercel AI SDK agent loop + the auth
   fetch; expose ONLY `tool-interface` tools (no shell), gate every call through `permission-gateway`;
   map AI-SDK stream → `AgentEvent`; produce the authoritative git diff.
4. **Inherit the rest:** `runBuilderMode → runExitGate → decideDelegationOutcome`; `runGated` +
   `BudgetLedger`; workspace-first; cockpit (consume `AgentEvent`).
5. **PROVE it (設定≠生效):** probe stories — no-shell-tool actually denies shell; permission gateway
   blocks an out-of-scope tool; write-set crux rejects an out-of-set change; **and a real refresh
   round-trips** (expired access → refresh → call succeeds) on the operator's subscription.
6. **Gated real run:** under `runGated`, a trivial story end-to-end on the **Codex subscription**;
   confirm diff gated + gate auto-closed + cost recorded.
7. **Secondary backend:** add **GitHub Copilot** (device-code) as a second provider — single
   controlled variable, same driver.
8. **Optional backstop + cleanup PR:** harness-level container + delete the ADR-19 §4.3 spawn-CLI
   list (bundle-backup first, human-confirmed).

---

## 6. Honest verdict & open decisions

**Verdict:** **opencode-style subscription backends ARE feasible** for GateLoop's target (Codex/
ChatGPT subscription), unlike the Agent-SDK route. The auth mechanism is portable plain `fetch`
(MIT), maps cleanly onto the Secret Broker, and matches GateLoop's stated default backend. **This
is not another "thought it worked, it didn't" — the subscription endpoint accepts a Bearer token we
fully control, and I read the working code.** The honest limits: **(a)** one-time human login (no
unattended provisioning), **(b)** unofficial/ToS-gray client reuse that OpenAI could change/block,
**(c)** an undocumented endpoint to track, **(d)** Claude subscription is off the table (use metered
keys). None is fatal for an operator-scoped builder; all must be designed for, not papered over.

**Open decisions (human gate):**
1. **Accept the ToS-gray subscription reuse?** For a personal/internal builder on the operator's own
   subscription, proceed with Codex; if GateLoop must be a *redistributable* product, treat
   subscription backends as operator-supplied-credential only and ship metered keys as the sanctioned
   default. **Recommend:** proceed for the build; flag clearly; don't market it as a blessed integration.
2. **Vercel AI SDK as the model layer?** Adopt `@ai-sdk/*` (as opencode does) for the loop/tooling,
   or hand-roll. **Recommend:** adopt the AI SDK — it's what makes the borrowed auth fetch drop-in.
3. **Login UX & storage:** reuse `~/.codex/auth.json` (already broker-known) or a GateLoop-native
   store. **Recommend:** broker reads the existing `~/.codex/auth.json` first; add `gateloop login`
   only if needed.
4. **Carry the ADR-19 §4.3 deletions now or after the new driver is green?** **Recommend:** after —
   never delete a working boundary before its replacement is proven.

---

## 7. opencode design lessons confirmed
- **Direct-backend with a custom auth `fetch`** beats spawning a binary: typed AI-SDK events,
  programmatic control, and subscription auth we fully own.
- **Credential as a provider-agnostic, refreshable union** (`oauth/api/wellknown`) is the right
  shape for the Secret Broker — store the refresh token, derive access on demand, never persist
  plaintext beyond the mode-600 store.
- **A thin provider adapter per backend** (not a monolith) keeps "add Copilot / add a metered key"
  a one-variable change — which is exactly how `model-gateway` already wants to grow.
