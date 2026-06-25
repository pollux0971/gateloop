# 29 — Planning Pipeline Test Strategy (the pyramid, offline-vs-gated, CI gate)

> **STORY-PTEST.1 — SPIKE/design.** Investigation + design only; this document ships
> **no test code**. It is the contract PTEST.2…PTEST.7 implement, grounded in the test
> harness already in the tree (root `vitest.config.ts`, the `@gateloop/web` jsdom root,
> and the ~30 existing planning-pipeline test files).

## 0. What we are testing

The "planning pipeline" is the EPIC-PFLOW…PWIRE + EPIC-PLLM feature: a deterministic
workflow engine (`@gateloop/planning-steward`), the doc-skill runtime + completion
checker, the three BMAD skills, the API surface (`apps/api` `/api/planning/{flow,
advance,author}`), the console node-flow (`@gateloop/web` `planflow.js`), and the LLM
authoring wire (author-prompt builder → StageDocAuthor seam → author→advance loop).

Per-story unit tests already exist (planning-steward 183 across 15 files; the jsdom
DOM landing test; the PLLM seam/loop tests). This epic adds the **higher tiers** that
unit tests miss, plus a CI guard that keeps the whole thing **offline and zero-cost**.

## 1. The test pyramid — layers

**Behavior:** `test_pyramid_layers_defined_unit_contract_property_edge_browser_llm`.

From widest/cheapest (bottom) to narrowest/heaviest (top):

| Layer | What it proves | Where | Owner story | Status |
| --- | --- | --- | --- | --- |
| **Unit** | each function's contract in isolation (parser, sequencer, checklist evaluator, barrier, author-prompt, seam, loop) | `packages/planning-steward/src/*.test.ts` | shipped (PFLOW/PSKILL/PBMAD/PLLM) | ✅ exists |
| **API contract** | endpoint response **shapes** + every **error path** (`/api/planning/flow`, `/advance`, `/author`) | `tests/api_planning_*.test.ts` | **PTEST.2** | adds error-path coverage |
| **Property / invariant** | the engine's guarantees hold over **many randomized inputs**, not just hand-picked cases (stage ordering can never skip; a blocked advance never mutates state; checklist score ∈ [0,total]) | `tests/` (seeded) | **PTEST.3** | new |
| **Negative / edge integration** | malformed config, missing skill dir, partial/empty docs, blocked→fix→advance recovery, reset | `tests/` | **PTEST.4** | new |
| **Browser E2E** | the REAL console in a REAL browser (Playwright) drives a full flow — the heavy counterpart to the lightweight jsdom landing test | `tests/e2e/` (Playwright) | **PTEST.5** | optional, heavier |
| **LLM-loop (offline)** | the author→advance loop with the **scripted** author: convergence, give-up, key-missing-fails-loud | `tests/` + planning-steward | **PTEST.6** | offline |
| **CI gate** | the offline suite is green AND gated/real-spend tests are excluded; coverage threshold; behavior-id↔it()-name convention enforced | `tests/` + config | **PTEST.7** | gate |

The jsdom DOM landing test (`tests/pwire_dom_landing.test.ts`, PWIRE.5) sits between
integration and browser-E2E: real DOM, real `planflow.js`, in-process API, no network —
the cheap always-on integration proof; Playwright (PTEST.5) is the full-browser
complement.

## 2. Offline vs gated classification

**Behavior:** `offline_vs_gated_classification_documented`.

The hard line: **everything that runs in CI is offline + deterministic + zero-cost.**
The only thing that spends is the PLLM.6 real run, which is *not a test*.

| Class | Definition | How it is kept out of CI | Examples |
| --- | --- | --- | --- |
| **Offline (CI)** | no network, no provider, no key; deterministic | matched by `vitest` `include` and runs every CI invocation | all `*.test.ts` under `packages/**/src` and `tests/` |
| **Gated (never CI)** | touches a real provider / `.env` key / spends | **named so `vitest` never collects it** — it is **not** a `*.test.ts` (e.g. `tests/pllm6_real_epics_run.ts`), and it **fail-closes** without an explicit opt-in env flag (`PLLM6_REAL=1`) | `tests/pllm6_real_epics_run.ts` |

Two independent guarantees make "never in CI" real (defense in depth):
1. **Collection**: the root `include` globs are `packages/**/src/**/*.test.ts` and
   `tests/**/*.test.ts`. A runner that is not a `*.test.ts` is never collected.
2. **Fail-closed**: even if invoked directly, the gated runner refuses
   (`optIn !== true` → throws / exits 2) so a stray invocation spends nothing.

The scripted author is the offline stand-in for the real provider everywhere — the
seam (PLLM.3) selects scripted-by-default, so the LLM-loop tests (PTEST.6) exercise the
real loop logic with zero cost.

## 3. Coverage targets + the behavior-id↔it()-name convention

**Behavior:** `coverage_targets_and_behavior_id_to_it_name_convention_documented`.

### 3.1 The convention (already in force, made machine-checkable in PTEST.7)

Every acceptance behavior id in a `STORY-*.md` `behaviors_must_pass:` list maps **1:1**
to an `it('<behavior_id>', …)` test name. This is already the de-facto rule across the
pipeline (e.g. `advance_blocked_returns_failing_items_and_reason_when_incomplete`,
`real_author_with_no_key_fails_loudly_never_silently_fakes_success_invariant`). PTEST.7
makes it enforceable: a meta-test scans the story files for behavior ids and asserts a
matching `it()` name exists somewhere in the suite (so a behavior can never silently
lose its test). Invariant/barrier behaviors keep the `_invariant` / `_barrier` suffix.

### 3.2 Coverage targets (enforced in PTEST.7)

Coverage is measured on the **product** code of the pipeline, not the tests or the
gated runner. No coverage provider is installed yet (`@vitest/coverage-v8` is added in
PTEST.7). Targets — a floor that fails CI if regressed, not a vanity 100%:

| Scope | Line/statement floor | Rationale |
| --- | --- | --- |
| `packages/planning-steward/src` (engine, checker, author core) | **90%** | the deterministic core — the most testable, highest-value code |
| `apps/api/src/planning.ts` (the API service + author loop) | **85%** | contract + error paths covered by PTEST.2/.4 |
| `apps/web/public/planflow.js` (node-flow + real-mode client) | **75%** | DOM-driven; jsdom + real-mode tests cover the logic, the heavy browser paths are PTEST.5 |

Coverage **excludes**: `*.test.ts`, `tests/pllm6_real_epics_run.ts` (gated runner),
generated/`dist`, and type-only files. Thresholds live in the vitest config so CI fails
on regression.

## 4. CI runs the offline suite and excludes gated tests

**Behavior:** `ci_runs_offline_suite_and_excludes_gated_tests_documented`.

CI is exactly: `pnpm typecheck && pnpm test` (root vitest) `&& pnpm --filter
@gateloop/web test` (the jsdom root). This:
- runs **every** offline `*.test.ts` (unit + contract + property + edge + DOM landing +
  LLM-loop offline + the PLLM.6 *gating guard* `pllm6_gating.test.ts`, which is offline);
- never collects the **gated runner** (`pllm6_real_epics_run.ts` — not a `*.test.ts`);
- never selects `mode:'real'` anywhere (the author seam defaults to scripted), so no
  test path can resolve a key or call a provider.

PTEST.7 adds an **active proof** (not just a convention): a CI-side guard test that
asserts (a) the offline suite is green, (b) the gated runner exists but is excluded from
collection (so it can never spend in CI), and (c) every story behavior id has a matching
`it()` name. The Playwright E2E (PTEST.5) runs in a **separate, optional** job (it needs
browser binaries) and is not part of the default unit-CI gate — documented as such so a
missing browser never red-bars the core suite.

```
default CI (always):  typecheck → root vitest (offline *.test.ts) → @gateloop/web vitest
optional CI (opt-in): Playwright browser E2E (PTEST.5)
never in CI:          tests/pllm6_real_epics_run.ts (gated, fail-closed, not a *.test.ts)
```

## 5. Scope + story mapping (this is design only)

**Behavior:** `output_is_design_doc_not_test_code` — no test code here.

| Story | Builds | Layer | Offline? |
| --- | --- | --- | --- |
| PTEST.2 | contract tests for `/flow`+`/advance`+`/author` shapes + **all error paths** | API contract | yes |
| PTEST.3 | randomized **seeded** property/invariant tests on the engine | property | yes |
| PTEST.4 | negative/edge integration (malformed config, missing skill, partial docs, recovery, reset) | edge | yes |
| PTEST.5 | Playwright full-browser E2E (optional, separate job) | browser | yes (no provider) |
| PTEST.6 | author-loop offline tests: convergence, give-up, **key-missing-fails-loud** | LLM-loop | yes (scripted) |
| PTEST.7 | CI no-spend guard + coverage threshold + behavior-id↔it()-name enforcement | CI gate | yes |

Invariants the implementation keeps (each becomes a test in its story):
1. Every CI test is offline, deterministic, zero-cost.
2. The gated runner is never collected by vitest and fail-closes without opt-in.
3. The engine's ordering + non-mutation-on-block guarantees hold over randomized inputs.
4. Every story behavior id has a matching `it()` name (machine-checked).
5. Coverage floors fail CI on regression; the gated runner is excluded from coverage.

## 6. Open choices deferred to implementation (not blocking this spike)

- **Property generator** — a small seeded PRNG vs a dependency like `fast-check`. PTEST.3
  decides; a seeded PRNG keeps the dependency surface minimal and the runs reproducible.
- **Coverage provider** — `@vitest/coverage-v8` (added in PTEST.7); a dev-dependency,
  offline.
- **Playwright in CI** — kept an **optional** job so the default gate never depends on
  browser binaries; PTEST.5 wires it as opt-in.

None change the layer/offline-gated/CI shape above, so PTEST.2/.3/.4 can start against
this strategy immediately.
