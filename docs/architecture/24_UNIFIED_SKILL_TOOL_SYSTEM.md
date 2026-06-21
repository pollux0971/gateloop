# 24 — Unified Skill / Tool Management (backend-neutral; plugin-structure-inspired)

Status: **Proposed** (investigation only — nothing implemented; `real_api_calls`
remains `false`). Date: 2026-06-21. Author: builder investigation.

Companion: `23_PONYTAIL_INTEGRATION.md` (the forcing function for this work),
`05_SKILL_RUNTIME_MODEL.md`, `03_TOOL_AND_PERMISSION_MODEL.md`,
`06_CODEGRAPH_INTEGRATION.md` + `22_CODEGRAPH_WIRING.md` (EPIC-CW),
`16_MODEL_REGISTRY_AND_INTROSPECTION.md`. ADRs: ADR-0008 (skills-require-tests),
ADR-0004 (permission-gateway-before-tool-executor), ADR-0010.

Decision already taken (recorded here, not re-litigated): **build on GateLoop's own,
backend-neutral systems — do NOT adopt the Anthropic plugin *runtime*** (it binds
Claude Code; GateLoop is in-process multi-backend and has removed spawn-CLI — using it
would overturn EPIC-035). **Borrow plugin *structure/discipline* only.**

Sources inspected (read-only, not run): `ponytail-main.zip` — itself a fully
plugin-structured example (`.claude-plugin/plugin.json` + `marketplace.json` +
`commands/` + `skills/` + `hooks/`, and parallel `.codex-plugin/`, `.opencode/`,
`gemini-extension.json`). The official `claude-plugins-official-main` sample was **not
present in the workspace**; ponytail's own plugin packaging covered the structure
questions, so the investigation proceeded without it. (If the official marketplace is
later added, only §3.2's "borrow list" would need a second pass — the design holds.)

---

## 0. TL;DR (the ponytail-honest answer)

**The "unified skill/tool management system" mostly already exists.** Be disciplined:

- **Tools are already unified.** `tool-interface::ToolInterface` is a single schema'd,
  config-driven, per-role registry; grants live in `configs/tool_registry.yaml`; the
  permission gateway governs every call; the provider path exposes them as
  `mcp__gateloop__*` with **no shell by construction**. **codegraph is already a
  registered tool** in it (`query_codegraph`, wired in `provider-driver/confinement.ts`,
  toggleable via `scale_relevant`). → **Nothing to build here. YAGNI.**
- **Skills are *half* unified.** There is a manifest catalog
  (`skills/skill_manifest.json`), a per-skill manifest (`skill.json`), and a full
  lifecycle (validate → test-gate → register → quarantine). **The one real gap** is the
  ADR-023 §2.3 finding: a registered skill's `SKILL.md` **body never reaches the live
  prompt** — `composeSystemPrompt` injects only a name+summary bullet, and the role
  callsites pass no `mountedSkills` at all.
- **Do NOT merge the two registries into one "plugin framework."** Tools and skills have
  **different lifecycles** (a tool = typed handler + runtime invocation + permission
  gate; a skill = prompt text injected into context + test-gate). Merging buys nothing
  real and is exactly the over-engineering ponytail warns against.
- **What to actually do** is small: **(1) fix the skill-body→prompt wire**, **(2) ship
  ponytail as the first skill on it**, **(3) confirm/document codegraph is already in
  the tool registry**. A **~3-story epic**, not a framework build.

> The honest call: "unified" here means *finish the one broken wire and reuse the two
> registries that already work* — not *build a grand plugin platform.* Unification is
> already ~80% done; the remaining 20% is the wire.

---

## 1. 調查 1 — Inventory: what already manages skills, tools, codegraph

### 1.1 Tool layer — already a unified registry ✅
`packages/tool-interface/src/index.ts::ToolInterface` is the Agent-Computer Interface:
- Holds `ToolDefinition[]` (each: `name`, `description`, `input_schema`,
  `output_schema`, `scale_relevant?`, `enabled?`, typed `handler`) + per-role
  `ToolGrants`.
- `invoke()` = grant-check → enabled-check → **schema-validate** → run. A hallucinated
  or unauthorized call is rejected before the handler runs.
- Grants are **config** (`configs/tool_registry.yaml`, per-role `allowed_tools`).
- The provider path (`providerToolSet`, EPIC-035/035.3) exposes these under
  `mcp__gateloop__*`; `isShellLikeTool` denies shell by construction;
  `harness-core::buildProviderCanUseTool` routes every call through the **same**
  permission gateway (`evaluateToolRequest`) — no second policy, no self-grant.

This is, already, a standardized, backend-neutral, schema'd, config-gated tool manager.

### 1.2 codegraph — already a tool in that registry ✅
`makeCodegraphTool(backend)` registers `query_codegraph` (callers/callees/impact/
search/trace) as a normal `ToolDefinition`, `scale_relevant: true`, backend injected;
it is included in `defaultHighLevelTools`/`providerToolSet` and wired in
`provider-driver/confinement.ts` (EPIC-CW CW.5). So **codegraph "納入統一管理" is
already done** — it is not a special case, it is a toggleable tool. The adapter
(`codegraph-adapter`) is the read-only backend behind it. → **No integration work;
just document the default toggle (enable on large projects).**

### 1.3 Skill layer — managed, but the body never reaches the model ⚠️
`packages/skill-runtime` provides: `loadSkillManifest`/`validateSkillPackage` (reject
no-`tests/`), `selectSkillsForRole` (only `registered`, role-scoped),
`sortByDependencyOrder` (`depends_on`), `readSkillContent` (`SKILL.md` + `AVOID:`
lines + token estimate). Catalog: `skills/skill_manifest.json`. Per-skill:
`skill.json` (id, agent_role, description, version, status, tests, depends_on,
provenance, failure_signatures, leakage_audit). Lifecycle: ADR-0008 +
`08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`.
**Gap (ADR-023 §2.3):** `MountedSkill` carries only `{name, summary?}`;
`composeSystemPrompt` emits only a bullet; the `SKILL.md` body reaches only
`harness-core::getSkillView` (the read-only browser), never `askModel`; and
`producePatchProposal` passes no `mountedSkills`. So skill *procedures* are authored,
tested, registered — and then **not sent to the model**.

### 1.4 Are the three managed together or separately?
**Two parallel registries sharing the same design DNA**, plus codegraph living inside
the tool one:
| Capability | Registry | Metadata unit | Gate | Backend-neutral? |
|---|---|---|---|---|
| Tools (+ codegraph) | `ToolInterface` / `tool_registry.yaml` | `ToolDefinition` | permission gateway + schema | ✅ harness layer |
| Skills | `skill_manifest.json` | `skill.json` + `SKILL.md` | test-gate / lifecycle | ✅ harness layer |

Both are per-role, config-driven, manifest-described, and sit **above the
provider-driver** (so every backend — OpenAI pay-as-you-go / Codex subscription /
future — inherits them). They are *already* "unified" in the sense that matters
(GateLoop manages them above the provider). They are *not* one code path, and **should
not be** (§3.1).

---

## 2. 調查 2 — What to borrow from Anthropic plugin structure (form, not runtime)

Ponytail's plugin packaging shows the canonical layout: `plugin.json` (metadata:
name/description/version/author + a hooks pointer), `marketplace.json` (a catalog of
plugins), and the `commands/ skills/ agents/ hooks/ .mcp.json` category folders.

| Plugin element | Borrow for GateLoop? | Why |
|---|---|---|
| **`plugin.json` metadata discipline** (name, description, version, author/provenance) | **Already have it** — `skill.json` and `ToolDefinition` both carry standardized metadata. Borrow nothing new; keep the discipline. | GateLoop predates the question. |
| **`marketplace.json` catalog** (a top-level index of capabilities) | **Already have the equivalent** — `skill_manifest.json` (skills) and `tool_registry.yaml` (tools). | A merged "marketplace" is cosmetic. |
| **`skills/` category** | **Yes — this is the one live area** (the body→prompt wire). | Core. |
| **`commands/` (slash commands)** | **Drop.** GateLoop is in-process; there are no user slash commands at runtime. | Claude-Code-specific. |
| **`agents/` (pluggable subagents)** | **Drop.** GateLoop's "agents" are 4 fixed roles, not pluggable plugin agents. | Different concept. |
| **`hooks/`** | **Already have** GateLoop hooks (035.3 Stop/permission); no plugin-hook runtime needed. | Different mechanism. |
| **`.mcp.json` (declare MCP servers)** | **Already have** the provider MCP surface (`mcp__gateloop__*`); codegraph backend is injected, not declared via plugin file. | In-process. |
| **Plugin install / marketplace fetch runtime** | **Drop.** Binds Claude Code; overturns EPIC-035. | Decision §0. |

**Net borrow (ponytail-minimal):** only the *discipline* of (a) standardized manifest
metadata and (b) a `skills/<role>/<name>/` category layout with `SKILL.md` + manifest +
`tests/` — **both of which GateLoop already practices.** Everything else in the plugin
framework is either already covered or inapplicable to an in-process, backend-neutral
harness. The reusable *content* worth borrowing is skill *text* (as with ponytail, and
potentially `code-simplifier`/`skill-creator`-style skills later) — not the runtime.

---

## 3. 調查 3 — The unified system design (minimal-sufficient)

### 3.1 How far to unify — the honest boundary
**Unify the skill side (finish the wire); leave the tool side alone; do NOT merge
them.** Reasons a single merged registry is rejected:
- Tools need a typed handler, runtime invocation, schema-validated IO, and per-call
  permission gating. Skills need none of that — they are prompt text injected at
  compose time and gated by a *test* lifecycle, not a permission check.
- A merged `ToolDefinition | SkillPackage` type would be a union with almost no shared
  behavior — an abstraction with one real seam (both are "capabilities a role has"),
  which is YAGNI until something actually consumes that union.
- The genuine shared concept — "what capabilities does role R have?" — can be answered
  by a **thin read-only view** over both registries *if and when* an introspection/
  discoverability need appears. Until then: **defer** (see §3.5).

### 3.2 Fix the wire (the foundation, ADR-023 §2.3)
The only structural change:
1. Extend `MountedSkill` to carry the `SKILL.md` **body** (+ `AVOID:` lines), not just
   `name`/`summary`.
2. `composeSystemPrompt` injects skill bodies (dependency-ordered, token-budgeted via
   context-manager) under a `## Skills` section — preserving the **executor ↔
   introspection identity invariant** (`16_…`): the browser view and the model input
   stay composed by the same function.
3. Wire `mountedSkills` (from `selectSkillsForRole` → `sortByDependencyOrder` →
   `readSkillContent`) into each role's `askModel` call — `producePatchProposal`
   (developer) first, then supervisor/debugger/reviewer.
This benefits **every** skill, not just ponytail; ponytail is the forcing function.

### 3.3 Unified format — already standardized, keep as-is
Skills keep `skill.json` + `SKILL.md`; tools keep `ToolDefinition` +
`tool_registry.yaml`. Both already carry the plugin.json-equivalent metadata
(id/description/version/status/provenance). **No new manifest format.** (If a single
human-facing catalog is ever wanted, generate it as a read-only view — §3.5 — not a new
source of truth.)

### 3.4 ponytail as the first skill on the finished wire
Author `skills/developer/ponytail-lazy/` (and optionally
`skills/reviewer/ponytail-review/`): port `SKILL.md` (drop host cruft —
mode/config/statusline/MCP/hooks; keep the ladder; **add the two ADR-023 §3.3
coordination edits**: deletion bounded by the additive gate/contract; "question the
requirement" routed to escalation), write `skill.json` + `tests/` + `.memory.md`, pass
the lifecycle gate → `registered`. One intensity for v1 (the `full` equivalent);
mode-switching is YAGNI.

### 3.5 codegraph + backend-neutrality
- **codegraph:** already a registered tool (§1.2). Work = **confirm + document** the
  default toggle (enable on large projects, disable on small), and that it routes
  through the same permission/grant path. No build.
- **Backend-neutral, the real meaning of "unified":** both registries live in the
  harness layer **above `provider-driver`**, so whichever backend executes a role
  (OpenAI metered / Codex subscription / future) inherits the *same* skills + tools +
  gates. "Unified" is GateLoop managing capability *above* the provider — **not** every
  agent sharing one call interface. The wire fix (§3.2) makes this real for skills (it
  is already real for tools).
- **Deferred (YAGNI):** a merged capability catalog / read-only introspection view over
  skills+tools. Add only when a discoverability or dev-console need actually demands it.

---

## 4. 調查 4 — Proving it works (設定 ≠ 生效)

All offline / scripted providers / `real_api_calls=false`:
1. **Skill body truly reaches the live prompt** — assert the composed system prompt
   from `askModel` *contains the `SKILL.md` body text* (not just the bullet), for a
   registered skill, dependency-ordered, with `AVOID:` lines — and that the
   introspection view composes identically (`16_…` invariant). Contrast: before the
   wire, the body is absent.
2. **ponytail actually takes effect** — the ADR-023 §4 offline A/B: same N story
   contracts, ponytail-on vs -off, compare net added LOC + `changed_files`; assert
   on ≤ off, **acceptance/Validator verdict unchanged** (correctness held), and
   **additive-gate rejections / Observe self-corrections / escalations do not increase**
   (the §3.3 edits worked).
3. **Unification is real, backend-neutral** — swap the routed provider (still scripted)
   and assert the same skills mount and the same tools are granted/denied; assert
   codegraph toggles on/off by config and is permission-gated either way.
4. **"Set ≠ effective" discipline** — registering a skill or fixing the wire is not the
   acceptance; the acceptance is items 1–3 proven by a real harness run.

---

## 5. Epic plan

Proposed **EPIC-UST — Unified Skill/Tool (finish the wire + ponytail)**. Small by
design (ponytail discipline). Dependency chain: **S1 → S2/S3 → S4**.

| Story | Title | Scope | Depends on |
|---|---|---|---|
| **UST.1** | Skill body → live prompt wire | Extend `MountedSkill` w/ body+AVOID; `composeSystemPrompt` injects bodies (dep-ordered, token-budgeted), keeping executor↔introspection identity; wire `mountedSkills` into `producePatchProposal` (then supervisor/debugger/reviewer). Tests: composed prompt contains body. | — (foundation) |
| **UST.2** | ponytail-lazy as a registered developer skill | Port `SKILL.md` (+ ADR-023 §3.3 edits), `skill.json`, `tests/`, `.memory.md`; pass lifecycle gate → registered. | UST.1 |
| **UST.3** *(optional)* | ponytail-review as a reviewer skill | Map ponytail-review onto the Reviewer over-engineering pass; same lifecycle gate. | UST.1 |
| **UST.4** | Verification (生效) | §4 items 1–3 offline; record the (body-reaches-prompt ∧ LOC↓ ∧ correctness-held ∧ no-added-friction ∧ backend-neutral) bundle. | UST.2 (+UST.3) |
| — | codegraph confirm/doc | **Not a build story** — confirm `query_codegraph` registration + document the default scale toggle. Folds into UST.4 or a doc commit. | — |
| — | merged capability catalog / introspection view | **Deferred (YAGNI).** Open only on a real discoverability/dev-console need. | — |

**Engineering size:** one small epic, **~3 stories** (UST.1/.2/.4; UST.3 optional). The
dominant work is UST.1 (the wire); ponytail and codegraph are light. **No plugin
framework, no registry merge.**

## 6. Decision & consequences
- **Adopt the minimal path:** finish the skill-body→prompt wire, ship ponytail on it,
  confirm codegraph is already managed. Reuse both existing registries; borrow only the
  plugin *discipline* (already practiced), not its runtime.
- **Reject** (as over-engineering, with rationale on record): adopting the Anthropic
  plugin runtime; merging skills+tools into one registry/format; building a
  marketplace/catalog UI now.
- **Positive:** closes a real gap (skills never reached the model) that helps all
  skills; ponytail lands; codegraph confirmed unified; backend-neutrality made real for
  skills. **Risk:** UST.1 touches the shared prompt composer — must keep the
  executor↔introspection invariant and stay within the context-manager token budget;
  the ADR-023 §3.3 edits must land or the ponytail arm shows added additive-gate
  friction (UST.4 item 2 catches it). **Backstop:** existing additive gate + acceptance
  tests + Observe loop reject anything unsafe regardless.

## 7. 誠實結論 (the asked-for honest call)
- **How big should the unified system be?** *Small.* It is already ~80% built. Tools +
  codegraph are unified today; skills are unified except for one broken wire. The
  ponytail-honest move is to **finish the wire, not build a platform.**
- **How big is the wire gap?** Narrow and well-localized: `MountedSkill` +
  `composeSystemPrompt` + the role callsites (`producePatchProposal` first). One
  foundation story.
- **ponytail / codegraph intake?** ponytail = a normal registered skill on the fixed
  wire (1 story, +1 optional for the review variant). codegraph = **already a registered
  tool**; intake is confirm-and-document, not build.
- **Verdict:** feasible, low-risk, **~3-story epic**, backend-neutral, no plugin
  runtime, no registry merge. Unification is *finishing* what GateLoop started, not
  inventing a new framework.
