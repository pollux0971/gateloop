# 28 — Planning LLM Authoring (the wire that uses your .env key)

> **STORY-PLLM.1 — SPIKE/design.** Investigation + design only. This document is
> the contract the rest of EPIC-PLLM (PLLM.2…PLLM.6) implements; it ships **no
> production code**. It is grounded in the real seams already in the tree
> (`@gateloop/provider-driver`, `@gateloop/secret-broker`,
> `@gateloop/planning-steward` doc-skills, and `apps/api/src/planning.ts`), so
> the later stories reuse those seams rather than inventing new ones.

## 0. Why this epic exists (the gap)

The Planning pipeline that EPIC-PFLOW…PWIRE built is **structural only**: the
engine ORDERS stages (`brief→prd→architecture→epics`) and the PSKILL checklist
CHECKS the structure of a document the caller supplies (`advance({ doc })`).
Nothing in that path reads `.env` or calls an LLM — the document text has to come
from somewhere, and today that "somewhere" is the test fixture / the human typing
into the console. The landing review named this precisely: *the model is never
wired; the .env key is never used.*

EPIC-PLLM adds the missing wire — a server-side **StageDocAuthor** that turns
`idea + the stage's doc-skill (steps + template) + prior-stage docs` into the
document text, then feeds that text into the **existing** checklist-gated
`advance`. The author sits behind a seam with two implementations so that the
logic stays fully testable at zero cost (scripted) while the real key is consumed
in exactly one place (real), opt-in, never in CI.

```
            ┌───────────────────────── server side only ─────────────────────────┐
 idea ─────▶│  AuthorPromptBuilder      StageDocAuthor (seam)        author loop  │
 prior docs │  (PLLM.2, deterministic)  ├─ scripted (default, CI)    (PLLM.4)     │──▶ advance({doc})
            │   steps+template+context  └─ real (PLLM.3, reuses          │         │     (existing PWIRE.2,
            │     → prompt string          provider-driver + .env key)   ▼         │      checklist-gated)
            │                                                    POST /api/planning/author
            └─────────────────────────────────────────────────────────────────────┘
                          key resolved ONLY inside the real author's call boundary
```

---

## 1. The author-prompt contract (PLLM.2)

**Behavior:** `author_prompt_contract_designed_from_skill_steps_template_and_context`.

### 1.1 Inputs (all already available, no new sources)

A doc-skill is loaded by the existing `loadDocSkill(skillDir)`
(`packages/planning-steward/src/docskill.ts`) and exposes:

- `frontmatter` — `DocSkillFrontmatter` (name/label/description).
- `steps: DocSkillStep[]` — the just-in-time authoring steps (PSKILL.2's
  `StepSequencer` walks these).
- `template` — the document skeleton the author fills in.
- `checklist` — the completion conditions (`evaluateChecklist` scores these; the
  author does **not** see the checklist as input — see §1.4).

The *running context* is:

- `idea: string` — the operator's one-paragraph brief (the `brief` stage's text).
- `priorDocs: Record<StageId, string>` — documents authored by earlier stages
  (e.g. the `architecture` stage receives the approved `prd` text). This is what
  makes the pipeline a pipeline: each stage authors from the accumulated output.
- `stageId: string` — which stage we are authoring (`prd` | `architecture` |
  `epics`).
- `failingItems?: ChecklistItem[]` — **only present on a re-author** (the loop
  feeds back what the checklist rejected; see §3.2). Empty on the first attempt.

### 1.2 The builder is a pure function

```ts
// PLLM.2 — deterministic, offline, no I/O, no provider
interface AuthorPromptInput {
  stageId: string;
  idea: string;
  priorDocs: Record<string, string>;
  skill: DocSkill;                 // steps + template + frontmatter
  failingItems?: ChecklistItem[];  // present only on re-author
}
interface AuthorPrompt {
  system: string;   // maps to EngineRunInput.system
  prompt: string;   // maps to EngineRunInput.prompt
}
function buildAuthorPrompt(input: AuthorPromptInput): AuthorPrompt;
```

`buildAuthorPrompt` is a **string composition** with no randomness and no clock,
so "same input → byte-identical prompt" is a unit invariant (one of PLLM.2's
behaviors). It is the only place prompt wording lives, which keeps the scripted
and real authors driving off the same contract.

### 1.3 Prompt composition (deterministic order)

```
system: «You are the GateLoop Planning Steward authoring the {stageId} document.
         Follow the skill's steps in order. Fill the template. Output ONLY the
         document body in Markdown — no preamble, no fences.»

prompt:
  ## Idea
  {idea}
  ## Prior documents            ← omitted when priorDocs is empty (brief stage)
  ### {priorStageId}
  {priorDoc text}
  ## Authoring steps            ← skill.steps[*].instruction, numbered, in order
  1. {step 1}
  2. {step 2} …
  ## Template to fill           ← skill.template verbatim
  {template}
  ## Fix these issues           ← present ONLY on re-author (failingItems)
  - {failing item 1 text}
  - {failing item 2 text} …
```

The `## Fix these issues` block is how a blocked checklist becomes the next
prompt — the failing items are appended verbatim, so the author is told exactly
what to repair without ever being handed the raw checklist evaluator.

### 1.4 Why the checklist is *not* an input, but failing items *are*

Handing the full checklist to the author would let it "write to the test."
Instead: the author writes from steps + template; the **independent** PSKILL
checker (`evaluateChecklist`) judges the result; only on failure are the specific
failing items fed back. This preserves the PSKILL separation (author ≠ grader) and
keeps the "set ≠ effective" honesty intact — a doc passes because it actually
satisfies the conditions, not because the author was handed the answer key.

---

## 2. The StageDocAuthor seam (PLLM.3)

**Behavior:** `stage_doc_author_seam_designed_scripted_default_and_real_provider_driver_impl`.

### 2.1 One interface, two impls

```ts
interface StageDocAuthor {
  readonly kind: 'scripted' | 'real';
  /** idea + skill + prior docs (+ failing items on re-author) → document text. */
  author(input: AuthorPromptInput, opts?: { signal?: AbortSignal }): Promise<string>;
}
```

The seam is selected **scripted-by-default**; real is opt-in (see §2.4). This is
the same shape as the existing engine seam (`LanguageModelEngine` in
`packages/provider-driver/src/engine.ts`): one neutral interface, a
`scriptedEngine` for tests and an `aiSdkEngine` for the real path.

### 2.2 Scripted author — default, offline, CI, zero-cost

The scripted author is **deterministic** and never touches a provider. It builds
the document by expanding `skill.template` against the context (filling the
template's fields from `idea` / `priorDocs`, satisfying each step's required
section, and — on a re-author — patching exactly the `failingItems`). Because the
PSKILL checklist conditions are known structurally (e.g. "has an `## FR` section",
"no `TBD` placeholders"), the scripted author can produce a document that *passes*
on the first or second pass deterministically — which is what makes the whole
author→advance loop (PLLM.4) unit-testable with **no spend** and gives PTEST.6 a
real convergence / give-up fixture.

Implementation note: the scripted author may be implemented directly (pure string
build) OR by driving `createScriptedEngine({ parts })` and collecting its
`text-delta` parts — either keeps it on the same `LanguageModelEngine` contract as
the real path. The direct build is preferred for determinism + clarity; the
choice is left to PLLM.3 as long as the `StageDocAuthor` contract holds.

### 2.3 Real author — opt-in, reuses `@gateloop/provider-driver`, reads the .env key

The real author **borrows, does not rewrite**. It composes the existing seams:

```
buildAuthorPrompt(input)          // PLLM.2 — prompt string
   │  { system, prompt }
   ▼
createMeteredEngine({             // provider-driver/src/backends/metered.ts (REUSED)
   spec: pickMeteredBackend(backendId),   // 'openai' | 'anthropic'
   broker,                                // @gateloop/secret-broker — resolves <PROVIDER>_API_KEY
   streamText, modelFactory })            // AI SDK injected at the boundary
   │  LanguageModelEngine
   ▼
engine.stream({ prompt, system, signal }) // EngineRunInput
   │  AsyncIterable<EngineStreamPart>
   ▼
collect text-delta parts → document string ; 'finish' carries EngineUsage (cost)
```

Everything below the prompt is **already implemented** in `provider-driver`:
`createMeteredEngine` resolves the key inside its own closure
(`resolveMeteredKey(broker, spec)`), hands the plaintext only to the injected
`modelFactory`, and returns a neutral `LanguageModelEngine`. The author never sees
the key; the core never imports the AI SDK. The real author's *only* new code is:
build the prompt (PLLM.2), call `createMeteredEngine`, drain the stream into a
string, and surface `EngineUsage` for the cost ledger.

### 2.4 Selection: scripted-by-default, real opt-in

A single factory chooses the impl from explicit configuration — never from an
agent's choice (mirrors `model_routing.selection: config_driven`):

```ts
interface AuthorSelect {
  mode: 'scripted' | 'real';   // DEFAULT 'scripted'
  backendId?: string;          // required only when mode==='real' ('openai'|'anthropic')
  model?: string;              // optional; falls back to spec.defaultModel
}
function selectStageDocAuthor(sel: AuthorSelect, deps): StageDocAuthor;
```

- **Default / absent / CI** → `scripted`. Tests and CI never pass `mode:'real'`.
- **`mode:'real'`** → built only when explicitly requested (the console "real
  mode" toggle, or the gated PLLM.6 run). Requires the real provider gate to be
  open (`real_api_calls`) — the author factory does not flip it.

### 2.5 "Set ≠ effective" — real selected but no key fails LOUDLY

This is the landing finding's direct answer and a **named behavior** PLLM.3 must
prove. The real author inherits the loud failure from the reused seam:
`createMeteredEngine` already throws when the broker returns no key —

```ts
const apiKey = await resolveMeteredKey(deps.broker, deps.spec);
if (!apiKey) throw new Error(`no metered key for backend '…' (broker provider '…')`);
```

The contract: with `mode:'real'` and **no `.env` key present**, the author path
**throws** (a typed `AuthorKeyMissingError` wrapping that condition) — it MUST NOT
silently fall back to the scripted author and report fake success. PLLM.3 ships a
test asserting exactly this (real selected + empty secret source → throws, and the
fallback is *not* taken). PTEST.6 re-asserts it offline as `key-missing-fails-loud`.

---

## 3. Server-side author loop + `POST /api/planning/author` (PLLM.4)

**Behavior:** `server_side_author_loop_and_post_author_endpoint_designed_key_stays_server_side`.

### 3.1 Why server-side

Provider calls and key resolution happen **only on the API server**
(`apps/api`), exactly where `createPlanningFlowService` already lives. The browser
never receives the key, never calls a provider, and never sees a prompt
containing one. The console (PLLM.5) calls `POST /api/planning/author`; the server
does the authoring and the gated advance and returns only the resulting flow +
document + status. This is the same boundary the existing
`/api/planning/{flow,advance}` endpoints already honor.

### 3.2 The author→advance rewrite loop

```
authorAndAdvance(stageId, { idea, priorDocs, author, maxRewrites=N }):
  attempt 0:
    doc      = author.author({ stageId, idea, priorDocs, skill })          # PLLM.2 prompt → text
    res      = planningFlow.advance({ doc })                               # existing PWIRE.2 (checklist-gated)
    if res.advanced: return { ok:true, doc, attempts:1, flow:res.flow }    # converged
  attempt k (while k < N):
    doc      = author.author({ …, failingItems: res.failing_items })       # feed the block back (§1.3 Fix block)
    res      = planningFlow.advance({ doc })
    if res.advanced: return { ok:true, doc, attempts:k+1, flow:res.flow }
  # budget exhausted, still blocked:
  return { ok:false, reason: res.blocked_reason, failing_items: res.failing_items, attempts:N, flow:res.flow }
```

Key properties:
- The loop **reuses** `planningFlow.advance` — it does not re-implement the
  checklist gate. The author produces text; the existing gate judges it.
- `failing_items` from a blocked advance become the next prompt's `## Fix these
  issues` block (§1.3). This is the "feed checklist failures back" mechanic.
- Bounded by `maxRewrites` (N, default small). On exhaustion it stops with a
  clear reason (`give-up`), never an infinite loop — PTEST.6 covers both
  `convergence` and `give-up`.
- With the **scripted** author the whole loop is deterministic → offline,
  zero-cost, CI-safe. With the **real** author the same loop spends (gated).

### 3.3 The endpoint

```
POST /api/planning/author
  body: { stageId?: string,            # default: the active stage
          idea?: string,               # default: the brief already in state
          mode?: 'scripted'|'real',    # default 'scripted'
          backendId?, model?,          # used only when mode==='real'
          maxRewrites?: number }
  200:  { ok: boolean,
          stageId, attempts,
          doc: string,                 # authored document (server-rendered)
          advanced: boolean, from, to,
          blocked_reason: string|null, failing_items: ChecklistItem[],
          flow: PlanningFlowResponse } # same shape /advance returns
```

- `mode:'real'` is honored only server-side and only when the real gate is open;
  otherwise the server uses the scripted author (the default) — it never errors
  the request into spending.
- Record-only w.r.t. policy: like `/advance`, authoring writes **no** `policy.yaml`
  and opens **no** access gate. The only gate on the *advance* remains the quality
  checklist.
- The response carries `attempts` + `doc` so the console (PLLM.5) can show the
  authored text and how many rewrites convergence took.

---

## 4. Key handling + opt-in / never-in-CI rule (PLLM.4 / PLLM.6)

**Behavior:** `key_handling_and_opt_in_never_in_ci_rule_documented`.

### 4.1 Key handling (operator-trust, secret seam unchanged)

- The `.env` key is read **only** server-side, **only** through the existing
  Secret Broker seam (`SecretBroker.resolve(meteredKeyHandle(provider))`), and
  **only** inside `createMeteredEngine`'s closure. Plaintext never leaves that
  scope: not returned to the loop, not put in the response, not logged, not in any
  trace, not in any agent context. (`SecretBroker` already records resolved values
  for redaction; the provider-driver confinement hooks already redact secrets from
  traces.)
- The author code, the loop, and the endpoint handle **only** the resulting
  document text + `EngineUsage` — never the key. This honors CLAUDE.md "raw
  secrets never enter context" and the workspace `never-read-env-key` rule: the
  agent building this never reads `.env`; the *running product server* resolves
  the key at runtime via the broker.

### 4.2 Opt-in, never in CI

- **Default everywhere = scripted.** Every unit/integration test, every CI job,
  and the endpoint's default all use the scripted author → deterministic,
  zero-cost. CI never selects `mode:'real'`.
- **Real = opt-in + gated.** `mode:'real'` requires the `real_api_calls` gate to
  be open AND an explicit request (console toggle or the PLLM.6 runner). The
  author factory can **never** self-enable the gate (ADR-0013 / decision-matrix
  `real_api_calls` keep-stop: "agent can NEVER self-enable, user pre-authorises").
- **PLLM.6 (the only spend) is gated, opt-in, never in CI:** one real idea →
  real `prd→architecture→epics` via the real provider, cost recorded from
  `EngineUsage`, kill-switch reachable (the existing budget guard / `signal`).
  PTEST.7 actively proves the gated/real-spend tests are excluded from CI while
  the offline suite stays green.

### 4.3 Cost & kill-switch

`EngineRunInput.signal` (an `AbortSignal`) is already threaded through the engine
seam — the budget guard / kill-switch forwards it, so a real authoring run is
bounded and cancellable. Each `finish` part carries `EngineUsage`
(input/output tokens) which PLLM.6 records to the cost ledger. No new budget
mechanism is invented; the author run rides the existing one.

---

## 5. Scope, reuse, and what later stories build

**Behavior:** `output_is_design_doc_not_shippable_code` — this file is design
only; it adds no code and wires nothing. The mapping to implementation stories:

| Story | Builds | Reuses (borrow, don't rewrite) |
| --- | --- | --- |
| PLLM.2 | `buildAuthorPrompt` (pure, offline) | `DocSkill` (steps/template) from `loadDocSkill` |
| PLLM.3 | `StageDocAuthor` seam + scripted + real impl; `selectStageDocAuthor`; `AuthorKeyMissingError` | `createMeteredEngine` / `createScriptedEngine` / `SecretBroker` |
| PLLM.4 | `authorAndAdvance` loop + `POST /api/planning/author` | `createPlanningFlowService.advance` (PWIRE.2 checklist gate) |
| PLLM.5 | console "real mode" toggle calling the endpoint (DEMO/scripted kept default) | `window.__planflow` (PWIRE.3/.4) |
| PLLM.6 | gated real E2E: one idea → real epics artifact, cost recorded | the real author + the budget guard / cost ledger |

Invariants the implementation must keep (each becomes a test):
1. `buildAuthorPrompt` is deterministic (same input → identical prompt).
2. Author seam defaults to scripted; CI never selects real.
3. Real-selected + no key → **throws loudly**, no silent scripted fallback.
4. The loop reuses the existing checklist gate and converges or gives up under a
   bounded rewrite budget.
5. The key is resolved only inside the engine-build closure; it never appears in
   the response, logs, trace, or agent context.
6. No access gate is added; only the existing quality checklist gates the advance.
7. Real spend is opt-in, gated (`real_api_calls`), and excluded from CI.

---

## 6. Open questions deferred to implementation (not blocking this spike)

- **Default `backendId` for real mode** — `openai` vs `anthropic`. The metered
  registry already ships both; the router (model-gateway) picks. PLLM.3 wires the
  default; the console may expose the choice in PLLM.5.
- **`maxRewrites` default** — a small N (e.g. 2–3) keeps the loop bounded and
  PTEST.6's give-up case cheap. Final value set in PLLM.4 against the scripted
  fixtures.
- **Whether the scripted author drives `createScriptedEngine` or builds directly**
  — §2.2; either satisfies the contract. Decided in PLLM.3 for determinism.

None of these change the seam shapes above, so PLLM.2 can start against this
contract immediately.
