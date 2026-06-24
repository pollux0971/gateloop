# 27 — Planning Workflow Engine (SPIKE / design)

> **Status: design doc, not shippable code.** This is the deliverable of
> **STORY-PFLOW.1** (SPIKE/design). It designs the Planning Steward *spec
> pipeline* backbone that EPIC-PFLOW (engine), EPIC-PSKILL (skill runtime +
> completion checker), EPIC-PBMAD (the three BMAD skills + backend dry-run) and
> EPIC-PWIRE (API + frontend node-flow + DOM landing test) will build. No
> production wiring is introduced here — only the stage model, the doc-authoring
> skill-runtime shape, the completion-checker contract, and the API/frontend
> node-flow contract. Each downstream story implements one slice and PROVES the
> set≠effective invariant at its barrier (PFLOW.4 / PSKILL.5 / PWIRE.5).

It honors `gateloop/CLAUDE.md`: deterministic core, no LLM in the engine, and —
per **ADR-0013 (operator-trust)** — **introduces no access gate**. Stage
ordering and the checklist completion-check are **B-class correctness controls**
(they make "done" mean done and stop an agent producing a half-written spec);
they are *not* access control on the operator.

---

## 0. Why this exists (and what it reuses)

The Planning Steward already turns an idea into a planning **bundle**
(`requiredPlanningFiles()` → `00_idea_record.md … 09_acceptance_checklist.md`)
and can generate a backlog from it
(`generateBacklogFromPlanningBundle`, `@gateloop/planning-steward`). What is
missing is a **deterministic spine** that:

1. enforces the *order* in which the four planning documents are authored
   (**brief → prd → architecture → epics**), so architecture is never written
   before the PRD exists; and
2. tracks each stage's **status** (`todo → active → done`) as observable state a
   UI and an API can read.

This engine is the **state skeleton** every later epic builds on. It is
deliberately additive and **reuses** rather than replaces:

| Existing surface | Reused how | NOT changed |
| --- | --- | --- |
| `@gateloop/planning-steward` (`createPlanningBundle`, `validatePlanningBundle`, `generateBacklogFromPlanningBundle`, `requiredPlanningFiles`) | The engine lives **in this package** as a new module; the **epics** stage's generator IS `generateBacklogFromPlanningBundle` (borrow, don't rewrite — PBMAD.4) | Its public functions keep their signatures |
| `@gateloop/skill-runtime` (`loadSkillManifest`, `selectSkillsForRole`, `skill_manifest.json`) | The doc-authoring runtime sits **beside** it as a second, simpler loader; the role/agent skill registry is untouched | No registry merge (YAGNI — see §2.3) |
| `apps/web/public/console.html` `FLOWS` / `renderSteps()` / `advance()` | The node-flow is fed by `GET /api/planning/flow` instead of the hard-coded `FLOWS` array; DEMO fallback kept (PWIRE.3) | The render shape (`[name, desc]` + step index) is preserved |

---

## 1. Workflow stage model + status lifecycle  *(behavior 1)*

### 1.1 The four ordered stages

The planning spec pipeline is exactly four stages, in this fixed order:

| # | stage key | produced by skill (EPIC-PBMAD) | primary artifact |
| - | --- | --- | --- |
| 0 | `brief` | (operator idea intake — existing `classifyIdea` / `createPlanningBundle`) | `00_idea_record.md` |
| 1 | `prd` | `bmad-prd` | PRD doc (Overview / FR / NFR / success) |
| 2 | `architecture` | `bmad-architecture` | architecture doc (FR→module mapping) |
| 3 | `epics` | `bmad-epics-stories` (Epics generator = `generateBacklogFromPlanningBundle`) | epic/story graph → `03_epic_story_graph.md` |

> The four **workflow stages** are the BMAD doc-authoring spine. They are a
> coarser view over the existing 10-file **bundle**: `brief`↔`00`, `epics`↔`03`,
> with `prd`/`architecture` as the new authored documents the BMAD skills own.
> The engine tracks the four stages; the bundle validator
> (`validatePlanningBundle`) remains the deeper file-completeness check used at
> the bundle gate.

The stage list is **data**, loaded from a config file (PFLOW.2,
`planning_workflow.yaml`), not hard-coded in the engine — same input → same
state. The engine never assumes the list; it reads it.

### 1.2 Status lifecycle — `todo → active → done`

Each stage carries exactly one status:

```
todo  ──activate──▶  active  ──complete (checklist all-pass)──▶  done
  ▲                                                               │
  └───────────────────────  (no backward edge in normal flow) ───┘
```

- **`todo`** — not yet started; predecessor not `done`.
- **`active`** — currently being authored (exactly **one** stage may be `active`
  at a time, the just-in-time step sequencer in PSKILL.2 drives it).
- **`done`** — its completion checklist is fully satisfied (PSKILL.3/PSKILL.4;
  *all items pass*, see §3).

Derived flow facts the engine exposes:

- `activeIndex` — index of the single `active` stage (or the first `todo` if
  none active yet, or `length` when all `done`).
- a stage at index `i` is rendered `done` when `i < activeIndex`, `active` when
  `i === activeIndex`, else `todo` — this **matches the console's existing**
  `i<psStep?'done':i===psStep?'active':''` rule, so the frontend mapping is a
  one-liner (PWIRE.3).

### 1.3 Order enforcement (the invariant PFLOW.4 proves)

The one hard rule:

> **A stage cannot become `active` unless every stage before it is `done`.**

Concretely, the proposed engine surface (implemented in PFLOW.3, module
`@gateloop/planning-steward/src/workflow.ts`):

```ts
export type StageStatus = 'todo' | 'active' | 'done';
export interface PlanningStage { key: string; name: string; desc: string; }
export interface PlanningFlowState {
  mode: string;                 // e.g. 'greenfield'
  label: string;                // e.g. 'GREENFIELD'
  stages: PlanningStage[];      // ordered, from planning_workflow.yaml
  statuses: StageStatus[];      // parallel array, statuses[i] for stages[i]
}

// PFLOW.2 — loader: read planning_workflow.yaml → ordered PlanningStage[]
export function loadPlanningWorkflow(yamlText: string): { mode: string; label: string; stages: PlanningStage[] };

// PFLOW.3 — state machine
export function initFlowState(def): PlanningFlowState;     // all 'todo' except stage 0 'active' (or all todo)
export function activeIndex(s: PlanningFlowState): number;
export function canActivate(s: PlanningFlowState, i: number): boolean;   // all predecessors 'done'
export function activateStage(s: PlanningFlowState, i: number): PlanningFlowState; // throws if !canActivate
export function completeStage(s: PlanningFlowState, i: number): PlanningFlowState; // marks done; needs checklist (PSKILL.4)
```

- `canActivate(s, i)` ⇔ `s.statuses.slice(0, i).every(st => st === 'done')`.
- `activateStage` **throws** (does not silently no-op) when `canActivate` is
  false — order enforcement *bites*. **PFLOW.4** proves this by attempting to
  activate `architecture` while `prd` is still `todo` and asserting it throws /
  the state is unchanged (a real probe, not `|| true`).
- The engine is pure: `(state, action) → state'`. No I/O, no LLM, no clock —
  deterministic and trivially testable.

---

## 2. Doc-authoring SKILL-runtime shape  *(behavior 2)*

### 2.1 On-disk shape of a doc-authoring skill

Each document stage is driven by a **doc-authoring skill** — a directory with a
fixed convention (EPIC-PBMAD authors three of these: `bmad-prd`,
`bmad-architecture`, `bmad-epics-stories`):

```
skills/bmad/<skill-name>/
├── SKILL.md          # YAML frontmatter (role + when) then a markdown body
├── steps/            # ordered, just-in-time steps  (01_*.md, 02_*.md, …)
│   ├── 01_*.md
│   └── 02_*.md
├── template.md       # the output document's required shape
└── checklist.md      # COMPLETION conditions (the fine-grained rules)
```

`SKILL.md` frontmatter (parsed by the PSKILL.1 loader):

```yaml
---
name: bmad-prd
stage: prd                 # which workflow stage (§1.1) this skill drives
role: PM                   # human-facing role label (PM / Architect / SM)
when: "after the brief is done, to author the PRD"
inputs: [brief]            # prior stage artifacts it consumes
---
# (markdown body: role description + how the steps fit together)
```

### 2.2 Step sequencer (just-in-time)

`steps/` holds ordered step files. The **sequencer** (PSKILL.2) exposes **one
step at a time, in order** — the agent is never handed the whole skill at once
(keeps context tight; mirrors the existing skills' "Standard operating
procedure" discipline). The sequencer is pure state: `(steps, cursor) →
currentStep`, `advance` moves the cursor forward only.

`template.md` defines the **output format** the stage's document must follow;
`checklist.md` defines **when the stage is done** (§3).

### 2.3 Relationship to the existing skill platform — **two registries, not merged (YAGNI)**

The repo already has a skill platform (EPIC-014): `skill_manifest.json` +
`@gateloop/skill-runtime` (`loadSkillManifest`, `selectSkillsForRole`,
`readSkillContent`). That registry answers a *different* question — **"which
agent-role skills (developer/supervisor/debugger/planning-steward) mount into an
agent's prompt for a given role?"** — and its manifest schema
(`skill_manifest/v2`: `agent_role`, `enabled`, `depends_on`, `last_evaluation`,
`leakage_audit`, …) is shaped for that.

The doc-authoring skills answer **"how is *this one planning document* authored,
step by step, and when is it complete?"** Forcing them into the agent-role
manifest would mean inventing `stage`/`template`/`checklist`/`steps` columns the
agent-role registry never needs, and dragging the doc-authoring loader through
`selectSkillsForRole`'s role/enabled/dependency logic it does not want.

**Decision: keep two registries.** A *new, minimal* loader (PSKILL.1) reads the
`skills/bmad/<name>/` convention directly from disk. No shared manifest, no
merge.

| | Agent-role skill platform (EPIC-014) | Doc-authoring skill runtime (EPIC-PSKILL) |
| --- | --- | --- |
| Registry | `skills/skill_manifest.json` | filesystem convention `skills/bmad/<name>/` |
| Loader | `loadSkillManifest` / `selectSkillsForRole` | new `loadDocSkill(dir)` (PSKILL.1) |
| Unit | a role's mounted skill content | SKILL.md + steps/ + template.md + checklist.md |
| Question | "which skills for role X?" | "how to author doc Y, and is it done?" |
| Coupling | none added | none added |

> Per ADR-0013 the doc-skill **loads/registers unvalidated** (no test-gate on
> registration). But a **load error must surface, never be swallowed** — a
> missing `checklist.md` or malformed frontmatter **throws** at load time
> (proven in PSKILL.5). "Unvalidated registration" ≠ "silent failure": the
> former is operator-trust, the latter is a correctness bug.

---

## 3. Completion-checker contract  *(behavior 3)*

`checklist.md` carries the stage's completion conditions as a list of checkable
items. The checker (PSKILL.3) parses it and evaluates each item against the
authored document, returning `passed/total`:

```ts
export interface ChecklistItem { id: string; text: string; pass: boolean; }
export interface ChecklistResult {
  items: ChecklistItem[];
  passed: number;     // count of pass === true
  total: number;      // items.length
  complete: boolean;  // passed === total  (the stage-done predicate)
}
export function evaluateChecklist(checklistMd: string, doc: string): ChecklistResult;
```

- **`complete === (passed === total)`** — a stage is `done` **only when every
  checklist item passes**. This is the wire from quality into ordering: a stage
  with `9/10` is **not** `done`, so the next stage **cannot** activate (§1.3).
- Each BMAD skill ships its own `checklist.md` (PBMAD): e.g. `bmad-prd` →
  "every FR is testable, no TBD"; `bmad-architecture` → "every FR maps to a
  module"; `bmad-epics-stories` → "each story is single-dev-session sized, has
  no dependency on a later story in the same epic, AC in Given/When/Then".
- Wiring (PSKILL.4): `completeStage(state, i)` may only move stage `i` to `done`
  when `evaluateChecklist(...).complete` is true; otherwise it leaves the stage
  `active` (it does **not** throw — an incomplete checklist is a normal "keep
  working" state, not an error).

**PSKILL.5 proves** two cruxes with real probes: (a) an incomplete checklist
truly blocks `done` (and therefore blocks the next stage activating); (b) a
load error (missing/malformed skill file) truly surfaces (throws), never silent.

> This is a quality control on the **output**, not an access gate on the
> operator (ADR-0013). It stops an agent from declaring a half-written PRD
> "done"; it never stops the operator from doing anything.

---

## 4. API + frontend node-flow contract  *(behavior 4)*

### 4.1 `GET /api/planning/flow` (PWIRE.1) — read live engine state

Returns the live `PlanningFlowState` projected into the exact shape the console
node-flow consumes. Status is **derived per-stage** so the frontend mapping is
trivial:

```jsonc
// GET /api/planning/flow
{
  "source": "live",            // "live" | "sample"  (DEMO fallback, cf. cockpit convention)
  "mode": "greenfield",
  "label": "GREENFIELD",
  "activeIndex": 2,            // single active stage; done = i<activeIndex, active = i===activeIndex
  "stages": [
    { "key": "brief",        "name": "意圖 / Brief",  "desc": "你想做什麼",        "status": "done" },
    { "key": "prd",          "name": "PRD",           "desc": "需求草稿 (FR/NFR)", "status": "done" },
    { "key": "architecture", "name": "架構",          "desc": "元件與分層",        "status": "active",
      "checklist": { "passed": 3, "total": 5 } },   // optional: surfaced for the active stage
    { "key": "epics",        "name": "切 story",      "desc": "可驗收 backlog",    "status": "todo" }
  ]
}
```

This maps **1:1** onto the existing `renderSteps()` contract: `stages[i].name`/
`.desc` ⇄ the current `[name, desc]` tuple, and `status`/`activeIndex` ⇄ the
`psStep` comparison. PWIRE.3 refactors `renderSteps()` to take this object (and
to be **importable** for the DOM test) while keeping the hard-coded `FLOWS`
array as the **DEMO fallback** when `source` would be `sample`/the API is
unreachable.

### 4.2 `POST /api/planning/advance` (PWIRE.2) — checklist-gated, record-only

```jsonc
// POST /api/planning/advance   { "stage": "architecture" }
// success → stage completed, next activated:
{ "advanced": true,  "from": "architecture", "to": "epics", "flow": { /* new GET shape */ } }
// blocked by checklist (quality, NOT access):
{ "advanced": false, "stage": "architecture", "reason": "checklist 3/5 — not complete",
  "checklist": { "passed": 3, "total": 5, "items": [ /* failing items */ ] } }
```

- `advance` completes the named stage **only if** its checklist is complete
  (§3); else it returns `advanced:false` with the failing items. This is the
  **checklist gate = quality control**, not an access gate — it never blocks the
  operator, it blocks an *incomplete spec* from advancing (ADR-0013).
- **Record-only**: like the rest of the cockpit's human-action surface, it
  mutates the in-process engine/run state, **not** `policy.yaml` and **not** any
  protected path. No secret, no network, no provider call.

### 4.3 Frontend chat drives advance (PWIRE.4)

The Planning-Steward chat (the existing `psSay`/guided buttons) calls
`POST /api/planning/advance` instead of the local `advance()` increment; the
node-flow re-renders from the returned `flow`. DEMO mode still runs the local
script when there is no backend.

### 4.4 The DOM landing test (PWIRE.5 barrier — "名實相符")

The integration proof the operator asked for ("用 DOM 做前後端整合落地測試"):

1. load the **real** `console.html` into **jsdom**;
2. wire `window.fetch` to the **in-process** api handlers (`/api/planning/flow`,
   `/api/planning/advance`) — **no network, no provider**, CI-safe;
3. drive a full **brief → prd → architecture → epics** flow;
4. **assert the rendered DOM node-flow reflects the live engine** at each step
   (the `.step.done/.active` classes match the engine's `activeIndex`), and that
   advancing a stage whose checklist is incomplete does **not** move the DOM
   forward (set≠effective, proven through the DOM).

Full-browser Playwright E2E is explicitly left as a later add-on; the jsdom +
in-process landing test is the light, CI-runnable barrier.

---

## 5. Build order & barriers (DAG the /goal loop follows)

```
PFLOW.1 (this design)
  → PFLOW.2 loader (planning_workflow.yaml) → PFLOW.3 state machine → PFLOW.4 PROVE order bites (barrier)
    → PSKILL.1 doc-skill loader → {PSKILL.2 step sequencer, PSKILL.3 checklist evaluator}
        → PSKILL.4 stage-done wiring → PSKILL.5 PROVE checklist-blocks-done + load-errors-surface (barrier)
      → {PBMAD.1 bmad-prd, PBMAD.2 bmad-architecture, PBMAD.3 bmad-epics-stories} (parallel)
          → PBMAD.4 backend dry-run brief→epics (reuse generateBacklogFromPlanningBundle)
        → PWIRE.1 GET flow → {PWIRE.2 POST advance, PWIRE.3 frontend live} → PWIRE.4 chat drives advance
            → PWIRE.5 PROVE DOM front-back integration landing test (barrier)
```

Milestones: **PBMAD.4** = the whole spec pipeline runs in tests and emits a
valid epics artifact; **PWIRE.5** = front and back are proven 名實相符 through
the DOM.

---

## 6. Safety / ADR-0013 posture (recap)

- **No access gate introduced.** Stage ordering and the checklist completion-
  check are B-class correctness controls (make "done" mean done; stop an agent
  shipping a half-written spec). They do not gate the operator.
- **Deterministic / offline.** Engine has no LLM, no clock, no network;
  same input → same state. `real_api_calls` untouched.
- **Reuse, don't rewrite.** Epics generator = `generateBacklogFromPlanningBundle`;
  the agent-role skill registry is untouched; **no registry merge** (YAGNI).
- **Load errors surface, registration is unvalidated.** Per ADR-0013 a doc-skill
  registers without a test-gate, but a malformed/missing skill file **throws** —
  operator-trust is not silent failure.
- **Each barrier proves set≠effective with a real probe** (PFLOW.4 / PSKILL.5 /
  PWIRE.5) — no `|| true`, no skipped test.
