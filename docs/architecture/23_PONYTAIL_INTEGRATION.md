# 23 — Ponytail Integration (lazy-dev discipline) — ADR + Integration Plan

Status: **Proposed** (investigation only — nothing implemented; `real_api_calls`
remains `false`). Date: 2026-06-21. Author: builder investigation.

Companion ADRs: [ADR-0007 model-provider-gateway], [ADR-0008 skills-require-tests],
[ADR-0010 supervisor-decides-harness-executes]. Related: `05_SKILL_RUNTIME_MODEL.md`,
`16_MODEL_REGISTRY_AND_INTROSPECTION.md`, `12_RUNTIME_ALGORITHM_RULES.md` §9.

Source inspected: `ponytail-main.zip` (v4.7.0, MIT, Dietrich Gebert), extracted
read-only to a scratch dir. Not installed, not run.

---

## 0. TL;DR (the honest answer)

- **Ponytail is pure prompt injection.** Its core value — the "lazy senior dev"
  ladder (YAGNI → stdlib → native → installed dep → one line → minimum code) — is a
  ~100-line `SKILL.md`. Every shipping adapter (Claude hooks, MCP server, Pi/cursor/
  copilot/etc.) is just a **different delivery channel for that same text**. There is
  **no enforcement engine, no code analysis, no AST, no blocking hook** — nothing to
  "wire into" the tool layer. Confirmed by ponytail's own MCP README: *"Ponytail
  normally lives in the system context every turn."*
- **GateLoop already has the exact home for it:** a tested-skill bank
  (`skill-runtime` + `skill-tester`) and a single shared prompt composer
  (`composeSystemPrompt`). Ponytail *is* a skill; GateLoop *consumes* skills.
- **It does NOT conflict with Observe / anti-hallucination / contract-first** — they
  govern **different axes**. GateLoop guards *writing the wrong/destructive thing*;
  ponytail guards *writing too much*. There are **two coordination points** (deletion
  must defer to the contract + additive gate; "question the requirement" must route to
  escalation, not silent omission), both resolved by adapting ponytail's text — and
  both are **hard-backstopped** by existing gates even if adaptation is imperfect.
- **Engineering size:** the *philosophy* is a 1-story prompt edit. The *proper,
  test-gated skill* is a **small epic (~4 stories)** — because ponytail forces us to
  close a pre-existing gap: **GateLoop's skill→live-prompt wiring currently injects
  only a skill's name+summary, never its `SKILL.md` body.**

Recommendation: **Option B (proper skill), as a small epic.** Rationale in §6.

---

## 1. 調查 1 — What ponytail actually is (form decides everything)

### 1.1 The single source of truth
`skills/ponytail/SKILL.md` (~100 lines) holds the whole product: the persistence
rule ("ACTIVE EVERY RESPONSE"), the 6-rung ladder, the rules (no unrequested
abstractions, deletion over addition, fewest files, mark simplifications with a
`ponytail:` comment), the output format, three intensity levels (lite/full/ultra),
and the "when NOT to be lazy" carve-outs (trust-boundary validation, data-loss error
handling, security, accessibility, hardware calibration, **"lazy code without its
check is unfinished — leave ONE runnable check behind"**).

### 1.2 Every adapter emits identical text
`hooks/ponytail-instructions.js::getPonytailInstructions(mode)` reads that `SKILL.md`,
strips frontmatter, filters the mode-specific rows, and returns it as a string. The
**MCP server** (`ponytail-mcp/index.js`), the **Claude/Codex hooks**
(`claude-codex-hooks.json` → SessionStart + UserPromptSubmit), and the **Pi
extension** all call the *same* builder. The MCP README states this outright: the MCP
is "not a replacement for the always-on adapters … the clean option for hosts whose
only injection point is the prompt menu."

### 1.3 The "machinery" is cosmetic
- **Hooks** do **zero enforcement**. `ponytail-activate.js` (SessionStart) just (a)
  writes a `.ponytail-active` flag file for a statusline badge, and (b) emits the
  ruleset text as hidden context. `ponytail-mode-tracker.js` (UserPromptSubmit) only
  tracks `/ponytail lite|full|ultra` switches. No PreToolUse/PostToolUse gate, no veto
  over any tool call.
- **MCP** just returns the text (`ponytail_instructions`, `readOnlyHint:true`).
- **`ponytail-review` / `ponytail-audit` / `ponytail-debt`** are *additional skill
  prompts* — the agent does the analysis from the prompt; there is no analyzer code.
- **`config.js`** is just default-mode resolution (env var → `~/.config/ponytail/
  config.json` → `full`).

### 1.4 Verdict for調查 1
Ponytail's core value is obtained by **pure prompt injection**. The hooks/MCP/config
exist only because other hosts have awkward injection points and want a statusline
badge. **GateLoop, which composes its own system prompt in-process, needs none of that
machinery** — it just needs the text in the right place. → Integration nature is
**content, not mechanism.**

---

## 2. 調查 2 — GateLoop's skill / prompt-injection mechanism

### 2.1 The injection point
`packages/agent-core/src/composeSystemPrompt.ts::composeSystemPrompt(base,
mountedSkills, envelopeDocs)` is **the single, pure, shared** prompt composer. It is
used by *both* the executor (`askModel`, the live path) and the read-only
introspection endpoint (`16_MODEL_REGISTRY_AND_INTROSPECTION.md`) — "what you view is
composed the same way as what the model receives."

### 2.2 The skill system already exists
`packages/skill-runtime` provides the full lifecycle plumbing:
`loadSkillManifest` → `validateSkillPackage` (rejects a skill with no `tests/`) →
`selectSkillsForRole` (returns only `status === 'registered'`, role-scoped) →
`sortByDependencyOrder` (topological, `depends_on`) → `readSkillContent` (reads
`SKILL.md` + `AVOID:` lines from `.memory.md`, with a token estimate). A skill package
is `SKILL.md` + `skill.json` (manifest) + `tests/` + `.memory.md` (see `_TEMPLATE/`),
with `status ∈ draft / needs_tests / registered / quarantined`.

**Ponytail's format is a near-match.** Ponytail already ships as a `SKILL.md` with
frontmatter; GateLoop wants a `SKILL.md` body + a sibling `skill.json`. Porting =
write a `skill.json` wrapper and keep the body (minus host cruft). No format fight.

### 2.3 ⚠️ The gap ponytail forces us to confront
**The skill *body* does not currently reach the live model.** Two facts:

1. `MountedSkill` carries only `{ name, summary? }`, and `composeSystemPrompt` emits
   only a bullet list under `## Mounted skills` — i.e. **`- ponytail: …` one-liner,
   never the ladder itself.** The full `SKILL.md` body is read only by
   `harness-core::getSkillView` — the **read-only skill browser**, not `askModel`.
2. The Developer's real call,
   `developer-runtime::producePatchProposal`, invokes `askModel` with
   `prompt: { base: developerSystemPromptBase() }` and **no `mountedSkills` at all.**

So today, even GateLoop's *own* registered skills' procedures never reach the model
prompt — only their base role prompt does. **Mounting ponytail "as a skill" via the
current path would inject a single advisory line, not the discipline.** Closing this
wire is a prerequisite for the proper integration (and a latent win for every other
skill). This is the single biggest finding of調查 2.

---

## 3. 調查 3 — Coordination with Observe / anti-hallucination / contract-first

### 3.1 What Observe actually is (correcting a likely misread)
"Observe (治亂刪)" is **two distinct mechanisms in `developer-runtime`**, neither of
which is "don't delete code":

- **The Observe loop** (`runDeveloperObserveLoop`): produce → **apply the patch + run
  the affected tests** → green ⇒ submit / red ⇒ bounded self-correct / exhausted ⇒
  escalate. `assertDeveloperObservedBeforeEmit` makes "ship without running tests"
  throw. This is the ReAct *observe* step.
- **The additive gate** (`removedExistingBehavior` + the `additive` check in
  `producePatchProposal`): rejects, **pre-emit**, a `modify` that removes an
  **existing exported symbol an earlier story defined**, unless this story explicitly
  requires it (the "S2-deletion" root-cause fix). Deletes are rejected outright unless
  contracted.

### 3.2 The real tension, named honestly
| Ponytail says | GateLoop says | Genuine clash? |
|---|---|---|
| "Deletion over addition. Fewest files." | Additive gate: don't remove **existing exported** behavior unless the story requires it. | **Friction, not silent conflict.** |
| "Ship the lazy version and question the requirement in the same response." | Contract-first: the patch must satisfy `acceptance_criteria` / acceptance tests or **Validator fails it**. | **Friction, not silent conflict.** |
| "Lazy code without its check is unfinished — leave ONE runnable check." | Observe loop **must** apply + run tests; Developer produces initial tests. | **Aligned — reinforcing.** |

Why "friction, not conflict": the gates are **hard pre-emit/pre-completion
backstops**. A ponytail-nudged deletion of existing behavior is *rejected by the
additive gate*; an under-built patch *fails the acceptance tests*. Nothing unsafe
slips through. The cost of a naive paste is **wasted self-correction rounds and
escalations**, not breakage.

### 3.3 The two coordination edits (make friction → smooth)
When porting `SKILL.md`, scope the two clashing rungs to GateLoop's contract model:

1. **Deletion rung, bounded:** "Deletion over addition applies to *your own new code*,
   to dead code *this patch* makes redundant, and to over-engineering. **Never remove
   existing exported behavior unless this story's contract requires it** — that is the
   additive gate's job, and stripping it is a violation, not a simplification. Fewest
   *new* files, smallest *added* surface."
2. **"Question the requirement" → escalation channel:** "When a requirement looks
   over-built, **do not silently omit it.** Build the lazy version that satisfies the
   contract, and raise the question as a structured *escalation* ('Did the minimal X;
   Y may cover the rest — confirm?'). The contract, not your judgement, decides scope."

### 3.4 Overlap check
GateLoop has no pre-existing "anti-over-engineering" pass, so ponytail is **net-new
coverage, not a duplicate.** It is **complementary**: GateLoop's gates prevent
*writing the wrong/destructive thing and shipping it unverified*; ponytail biases the
model toward *writing less in the first place*. Different axes; they compose.
`ponytail-review` maps cleanly onto a future **Reviewer** over-engineering pass
(`06_REVIEWER_AGENT.md`), distinct from the correctness review.

### 3.5 Verdict for調查 3
**Complementary, with two bounded coordination edits, hard-backstopped by existing
gates.** No safety conflict. The work is in the *prompt text*, not in changing any
gate.

---

## 4. 調查 4 — Proving ponytail takes effect (設定 ≠ 生效)

Ponytail's own method: same task, **with-skill vs without**, count LOC from emitted
code + a **correctness gate** (a one-liner that's broken still fails). GateLoop can
run a *stronger, harness-native, zero-cost* version of this because it already has a
multi-story eval harness and **scripted providers** (no LLM, no network, CI-safe).

**Acceptance bundle (all offline / `real_api_calls=false`):**
1. **LOC / file delta down:** run N identical story contracts through the harness with
   the ponytail skill mounted vs not; compare net added lines + `changed_files` count
   in the emitted `patch_proposal`. Ponytail-on must be ≤ ponytail-off (per ponytail's
   "never writes more").
2. **Correctness held:** acceptance-test pass rate and Validator verdict **unchanged**
   between arms — simplification must not drop a guard (ponytail's own honest caveat
   from its agentic benchmark).
3. **No new friction with Observe:** additive-gate rejections, Observe self-correction
   rounds, and escalation counts **do not increase** in the ponytail arm — proof the
   §3.3 coordination edits worked.
4. **Ladder-followed evidence:** `rationale_summary` cites stdlib/native reuse; new
   dependencies added ≤ ponytail-off; `ponytail:` markers present on deliberate
   simplifications.

**The acceptance is the (LOC↓ ∧ correctness-held ∧ no-added-friction) triple proven by
a real harness run** — not "the skill is registered, so trust it." A real-provider A/B
is the higher-fidelity confirmation but is **gated behind `real_api_calls` (human-only,
per [feedback] real-api-gate-human-only)** and is out of scope here.

---

## 5. Integration options

### Option A — Fold the ladder into the role prompt bases (minimal)
Append the (adapted) ladder to `developerSystemPromptBase()` (and a review variant for
the Reviewer). Guaranteed to reach the model **today**; ~**1 story**.
- ➖ It becomes **prose hard-coded in TypeScript** — *not* a tested, versioned,
  quarantine-able skill. That contradicts `gateloop/CLAUDE.md` ("skills are tested,
  versioned assets") and ADR-0008. Can't be swapped, A/B'd, or audited as an asset.
- Use only as a fast spike, with a migration path to B.

### Option B — Ponytail as a registered, test-gated skill (recommended)
A small **epic (~4 stories)**:
1. **Close the skill-body→prompt wire (§2.3).** Extend `MountedSkill` to carry the
   `SKILL.md` body (dependency-ordered, with `AVOID:` lines), have `composeSystemPrompt`
   inject bodies (not just names), and pass `mountedSkills` from each role's `askModel`
   call (`producePatchProposal` first). *Latent win for all skills, not just ponytail.*
2. **Author the skill package(s):** `skills/developer/ponytail-lazy/` (+ optionally
   `skills/reviewer/ponytail-review/`). Port `SKILL.md` — **drop** host cruft
   (mode/config/statusline/MCP/hook text); **keep** the ladder, rules, output format,
   "when NOT to be lazy"; **add** the two §3.3 coordination edits. Write `skill.json`,
   `tests/`, `.memory.md`. Pick **one intensity** (the `full` equivalent) for v1 — mode
   switching is YAGNI here (ponytail's own lesson).
3. **Pass the lifecycle gate** (`08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`): tests pass in
   a disposable workspace + fresh-run robustness + leakage audit → `registered`. (Human
   gate for production promotion.)
4. **Verification story:** implement the §4 offline A/B and record the triple.

Mode/intensity as config: **deferred (YAGNI)** until a real need appears.

---

## 6. Decision

Adopt **Option B**. Reasons:
- Ponytail *is* a skill and GateLoop *is* a skill-consuming harness; forcing it into a
  hard-coded base prompt fights both designs.
- Step 1 closes a real, pre-existing gap (skill bodies never reach the live prompt)
  that benefits every skill — ponytail is the forcing function, not the sole
  beneficiary.
- It keeps the laziness discipline **testable, versioned, quarantine-able, and
  A/B-able**, honoring ADR-0008 / `gateloop/CLAUDE.md`.

If a fast demonstration is wanted first, **Option A as a throwaway spike** is
acceptable, with explicit intent to migrate to B (do not let spike prose ossify into
the permanent base prompt).

## 7. Consequences
- **Positive:** net-new "write less" coverage on an axis no current gate addresses;
  the skill-body→prompt wire gets finished; verification is honest and zero-cost.
- **Negative / risk:** Step 1 touches the shared prompt composer — must preserve the
  executor↔introspection identity invariant (`16_…`) and stay within token budgets
  (context-manager). The §3.3 edits must land or the ponytail arm will show increased
  additive-gate friction (which §4 item 3 is designed to catch).
- **Backstop:** even an imperfect port cannot ship anything unsafe — the additive
  gate, acceptance tests, and Observe loop reject destructive or under-built patches
  pre-emit / pre-completion.

## 8. Engineering-size summary (the asked-for honest call)
- Ponytail integration is **feasible and low-risk.**
- It is **pure prompt/skill injection** — **no hooks, no MCP, no tool-layer machinery**
  is required (GateLoop composes its own prompt in-process).
- It does **not conflict** with Observe / anti-hallucination / contract-first — they
  cover orthogonal axes; two bounded text edits remove the only friction, and existing
  gates backstop the rest.
- Size: **philosophy = 1 story; proper test-gated skill = a ~4-story epic**, dominated
  by closing the skill-body→prompt wire (§2.3), not by ponytail itself.
