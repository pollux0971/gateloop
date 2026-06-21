# STORY-UST.4 — Effectiveness Report (set ≠ effective, proven)

EPIC-UST's soul: not "is the wire connected / skill registered" but **does the body
really reach the model, and does ponytail really make the agent write less without
losing correctness or adding friction.** All offline checks are scripted/zero-cost;
one gated real-model A/B (billed) confirms the behavioural claim.

`real_api_calls`: **false** before, opened/closed+read-back by `runGated` only for the
single A/B, **false** after (verified). Date: 2026-06-22.

---

## WORK 0 — reviewer wire completed (ponytail-review reaches the live reviewer prompt)

UST.1 wired the developer callsite (`producePatchProposal`) "first"; the reviewer had
no askModel executor callsite at all (strategy-injected). Added to `reviewer-runtime`:
`reviewerSystemPromptBase()`, `reviewerMountedSkills()`, `composeReviewerSystemPrompt()`,
and `makeModelReviewStrategy(deps)` — the reviewer executor wire, mirroring the
developer's. It mounts registered reviewer skills (bodies, dependency-ordered) via the
SAME `composeSystemPrompt`, so `reviewer.ponytail-review` now reaches a live reviewer
prompt. (`runReviewer` still strips write-set/goal fields + validates — invariants held.)

## WORK 1 — body truly in the live prompt + isomorphism (offline, byte-identical)

`tests/ust4_body_in_prompt_isomorphism.test.ts`:
- **developer** prompt contains the ponytail-lazy ladder body (`## Skill procedures`,
  "minimum code that works", the §3.3 "Never remove an existing exported" binding) —
  with the **direct contrast** that a name-only mount yields a bullet and NO body section.
- **reviewer** prompt contains the ponytail-review body ("Lean already. Ship.", "Never
  flag the ponytail minimum").
- **executor ↔ introspection isomorphism**: for BOTH roles,
  `getAgentPromptView(...).composed` is **byte-identical** to the executor's
  `composeSystemPrompt(...)` (same shared function, same body-carrying loader input).

## WORK 2 — ponytail truly reduces LOC: the three-fold

**code↓ ∧ correctness held ∧ no added friction.**

### Offline machinery (scripted, zero cost) — `tests/ust4_ab_offline.test.ts`
Scripted providers ignore the prompt, so they cannot themselves show a model writing
less — that is the gated arm's job. Offline proves the **measurement + gates + §3.3
coordination** are sound:
- A **bounded-lazy** patch (ponytail-correct: 1 file/2 lines, existing exports
  preserved) vs an **over-built baseline** (3 files, class+config+factory): the
  three-fold verdict passes — fewer LOC/files, both accepted (correctness held), no
  added friction.
- A **naive-lazy** patch (what ponytail WITHOUT the §3.3 deletion-binding would do —
  rewrite a shared file and drop an existing `parseMoney` export) is **REJECTED by the
  additive gate**. That rejection is exactly the friction the coordination edit
  prevents → the edit is **load-bearing**, not decorative.

### Gated real-model A/B (one billed run) — `tests/ust4_ab_gated.test.ts`
Method = ponytail's own published benchmark: same task (`debounce(fn, ms)`), single-shot,
LOC from the fenced block, structural correctness check. Two arms differ ONLY by the
system prompt — baseline vs baseline + the registered ponytail-lazy SKILL.md body (the
exact text the UST.1 wire mounts). Real metered model on `api.openai.com` (broker key),
`runGated` open→spend→close+read-back.

| Arm | LOC | correct (real debounce: setTimeout+clearTimeout) | input tok |
|---|--:|:--:|--:|
| baseline (no ponytail) | 10 | ✅ | 45 |
| **ponytail (body mounted)** | **7** | ✅ | 964 |

- **code↓**: 7 ≤ 10 ✅
- **correctness held**: both arms produce a real debounce ✅ (ponytail wrote less, did
  not drop the cancellable timer)
- **no added friction**: ponytail arm kept the core; nothing rejected ✅
- **three-fold pass**: ✅
- The ponytail arm's **964 input tokens** (vs 45) is the body genuinely reaching the
  real model — set *and* effective.
- `gateClosedVerified: true` ("gate auto-closed and verified").

## WORK 3 — backend-agnostic (offline, zero cost) — `tests/ust4_cross_provider.test.ts`

- Skills: the same mounted SKILL.md body reaches the composed prompt under **provider-a**
  and **provider-b** — `composed_system_prompt` is byte-identical across the swap (the
  registries live above provider-driver).
- Tools: the per-role grant, the `query_codegraph` permission-gating, and the codegraph
  scale toggle are decided by the tool layer, not the provider — identical across
  providers; codegraph stays a toggleable, permission-gated registered tool.

## Cost & safety

- A/B spend: **~1,119 tokens** (1,009 in + 110 out) ≈ **well under $0.05** (≪ $5 cap).
- `real_api_calls`: false → (gated, both calls) → **false** after, read-back verified.
- Key via Secret Broker `subprocessEnvSource` (a child sources `.env`; agent never reads
  plaintext). Core packages import no AI SDK (AI SDK only in scripts). Registries NOT
  merged (skill-runtime vs tool-interface stay separate). Inherited gates green
  (additive gate, Observe, exit gate, tool-layer confinement) — full suite 118 files
  1395 pass / 9 skip, typecheck 0.

## Honest conclusion

- **Unified skill/tool system is EFFECTIVE, not just configured.** A registered skill's
  SKILL.md body reaches the live prompt for developer AND reviewer, byte-identical to
  the introspection view. The wire is real.
- **ponytail truly reduces code AND keeps correctness AND adds no friction** — proven
  offline (the checking machinery + the load-bearing §3.3 coordination) and confirmed on
  a real model (7 vs 10 LOC, both correct). Less code, not less done.
- **Backend-agnostic**: skills, tool gate, and codegraph are identical across a provider
  swap — "unified" means GateLoop manages capability above the provider.
- Scope honesty: the gated A/B is one trivial task (debounce); it proves the PATH and a
  real reduction, not that ponytail wins on every task — consistent with ponytail's own
  "honest number" caveat. The offline three-fold + the §3.3 load-bearing rejection are
  the durable, reproducible guarantees.

**EPIC-UST is complete**: the one broken wire is finished (all skills now effective),
ponytail is landed (developer + reviewer, reduces code without losing correctness or
adding friction), and the system is backend-agnostic — with registries deliberately NOT
merged (YAGNI). GateLoop + ponytail are ready.
