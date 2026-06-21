# PROVIDER METERED OpenAI E2E — the product-default path, real-model verified

**EPIC-035 (b) — the literal metered-key gated run.** A real model worked a trivial story
IN-PROCESS through the tool layer on a **standard, metered OpenAI API key** against
**api.openai.com**. This is the last unverified segment of the product's endorsed, distributable
default path: the metered-key authentication + `api.openai.com` endpoint route. It turns the ADR
claim *"same pipeline, only the credential/endpoint differ — swap fetch/engine"* from
unit-test + inference into a real-model fact.

- Harness: `scripts/provider-mode-metered.ts` · `tests/provider_mode_metered_e2e.test.ts`
- Date: 2026-06-21 · Operator: pollux · Not pushed.
- Sibling of 035.5 (`provider-mode-codex.ts`, the Codex **subscription** run). **Single controlled
  variable: the engine/auth/endpoint.**

| | 035.5 (subscription) | (b) metered (this run) |
|---|---|---|
| key | Codex OAuth (`~/.gateloop/codex-auth.json`) | `OPENAI_API_KEY` via Secret Broker (operator `.env`) |
| model build | `createOpenAI({apiKey:'dummy', fetch: createCodexFetch})` | `createOpenAI({apiKey: <broker key>})` (no custom fetch) |
| endpoint | `chatgpt.com/backend-api/codex/responses` | **`api.openai.com/v1/responses`** (standard) |
| engine wrapper | (driven via streamText) | **`createMeteredEngine`** (literally exercised) |
| tool layer / sandbox / exit gate | identical | identical |

---

## 1. Metered authentication + endpoint (what this run verifies) — ✅

- **Secret Broker, agent never reads the key.** The key is resolved via
  `subprocessEnvSource({ envFile: .env })`: a **child process** sources the operator's `.env` and
  returns only the value. Neither the agent nor this script ever reads `.env`; plaintext lives
  only inside the `broker.resolve()` / `createMeteredEngine()` closure and is never returned to the
  core, logged, or printed. Broker presence check: key present, length > 20 (value never surfaced).
- **`createMeteredEngine → api.openai.com` proven literally.** The engine smoke built the metered
  engine through the product's own `createMeteredEngine` (broker resolves the key inside its
  closure; `modelFactory` builds a standard `createOpenAI(...).responses(model)` → `api.openai.com`)
  and consumed a one-token reply: **`"ok"`**, usage **input 23 / output 5**. The metered engine
  wrapper reaches the standard endpoint and authenticates.
- **Wire-format correct.** No 400s. The earlier invalid-key attempt returned a *structured*
  `401 invalid_api_key` from OpenAI — i.e. the request shape, endpoint, and auth-header injection
  were already correct; only the credential was stale. After the operator refreshed `.env`, the
  same code path authenticated and returned content. **"Swap fetch/engine" is literally true.**

## 2. Tool layer (highest priority) — ✅ held, no breach

The real model's every tool call passed through the `ConfinedToolMediator` (default-deny surface,
real permission gateway, Pre/Post hooks, audit log). Observed audit for the story run:

| tool | decision | defaultDenied | executed |
|---|---|---|---|
| `write_file` | allow | false | ✅ |
| `report` | allow | false | ✅ |

- **Whitelist-only.** The model called only `write_file` and `report` — both allowed and executed.
- **No breach.** Zero Bash, zero secret-path read, zero out-of-write-set attempt.
- **default-deny ready, none needed.** The model behaved; no unexpected tool was reached for, so no
  default-deny fired (the default-deny + observation layer, proven in 035.4, stood ready). Honest
  framing: a well-behaved run does not *exercise* default-deny — it confirms the model stayed inside
  the surface; 035.4's bypass probes are what prove the deny path bites.

## 3. Completion + exit gate — ✅

- **Story completed.** The model created exactly `slugify.mjs` and called `report`.
- **Authoritative diff** (sandbox `git diff` vs the pre-task tree): `changed_files = ['slugify.mjs']`.
- **Exit gate ACCEPTED**, `out_of_write_set = []`. The in-write-set diff was accepted clean; the
  inherited exit gate (write-set + spec + validator + regression) is the same one 035.5 used. The
  out-of-write-set → REJECT_WHOLE crux is proven by the fixture (a scripted out-of-set attempt) and
  by 035.4's write-set invariant; this real run produced no out-of-set change to reject.

## 4. Cost (vs 035.5 subscription's 1389 tokens)

| call | input | output | total |
|---|---|---|---|
| engine smoke | 23 | 5 | 28 |
| story | 1238 | 151 | 1389 |
| **run total** | **1261** | **156** | **1417** |

Tokens are the authoritative cost unit. At standard metered frontier rates this is on the order of
**< $0.01** — well under the per-run estimate and far under the $5 budget cap. (The failed
pre-refresh 401 cost **$0**: a rejected key means no model invocation.)

## 5. Core AI-SDK isolation — ✅ still 0 importers

`grep` over `packages/*/src` for `@ai-sdk` / `from 'ai'` → none. The AI SDK lives only in the
scripts (`provider-mode-metered.ts`, `provider-mode-codex.ts`); the provider-driver core imports it
nowhere. Isolation test `provider_driver_ai_sdk_isolation` (3) green. The metered harness is also
**fully detachable from the subscription plugin** — `provider-mode-metered.ts` imports no
`@gateloop/subscription-auth`; `subscription_detachable_035_6` (2) still green.

## 6. Gate discipline — ✅ auto-closed, read-back verified

`real_api_calls` was opened and closed by `runGated` for each billed call (engine smoke, story),
each with read-back verification; it reads **`false`** before and after every call. The tool-layer
confinement barrier (035.4) was re-proven held as a fail-closed precondition before any spend
(`assertToolLayerConfinementBarrier` + `requireConfinementBeforeSpend`).

> **Gate authority note.** Per the standing human-only gate rule, `real_api_calls` is normally
> flipped only by the operator. For this run the operator **explicitly authorized Claude to invoke
> `runGated`** (which performs the open→spend→close+read-back) for the (b) metered verification. The
> authorization and the flips are recorded in `builder/tracker/decision_log.md`.

---

## Honest conclusion

**The product-default path holds end-to-end with a real model.** A standard metered `OPENAI_API_KEY`,
resolved through the Secret Broker, drives a real model on the standard `api.openai.com` endpoint via
`createMeteredEngine`; the model works a trivial story entirely inside the confined tool layer (no
breach), and the authoritative diff passes the inherited exit gate — all under gate discipline with
the core importing no AI SDK. EPIC-035's endorsed, distributable, officially-supported default
(metered key + standard endpoint) is now **verified by a real run**, not just unit tests + inference.

**Scope honesty.** One trivial, well-behaved story on `gpt-5.4`. It proves the *path* works
(auth + endpoint + engine + tool layer + exit gate), not that the model never misbehaves on harder
tasks — the default-deny + observation layer (035.4) is what stands ready for that, and it did not
need to fire here. The single controlled variable vs 035.5 was the engine/auth/endpoint; everything
else was byte-identical pipeline.
