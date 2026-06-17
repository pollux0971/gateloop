# Agent Skill Catalog and Capability Layers

**Status:** design baseline for EPIC-014 / EPIC-015 · **Layer:** product docs (agents)

Two questions this document answers:
1. What skills does each of the four agents need? (catalog below)
2. Are skills alone enough? **No** — see the five-layer capability model at the end.

Skill system references: `../architecture/05_SKILL_RUNTIME_MODEL.md`,
`../workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`,
`specs/skill_package.schema.json`, `skills/skill_manifest.json`.

---

## Inventory (v23) — the imbalance

| Role | Skills today | Assessment |
| --- | --- | --- |
| planning-steward | 11 (idea-to-epic, prd-authoring, architecture-design, epic-story-sharding, machine-checkable-acceptance, write-set-and-guards, acceptance-test-scaffold, behavior-test-derivation, interface-contract-spec, documented-stub-registry, program-spec-assembly) | Rich — near-complete for greenfield planning |
| supervisor | 1 (story-contract) | **Starved** — the decision-maker has almost no codified judgment |
| developer | 3 (patch-proposal, pre-flight-check, spec-conformance) | Thin — no localization or scaffolding skills |
| debugger | 1 (failure-triage) | **Starved** — triage exists, repair doctrine does not |
| shared | 3 (codegraph-query, structured-escalation, task-decomposition) | OK |

**Systemic gap:** all 19 skills are `needs_tests` because the skill-tester gate
(runSkillTests / robustnessCheck / leakageAudit / registerSkill) is stubbed.
Until EPIC-014.1 lands, no skill has validator evidence — the project's own
trust rule does not yet apply to its skills.

---

## Target catalogs (gap fill)

### Supervisor (+5, STORY-014.3)
| Skill | Codifies |
| --- | --- |
| task-packet-composition | contract → role-scoped Task Packet (write-set, acceptance, budget) |
| decision-matrix-routing | applying `configs/decision_matrix.yaml`: develop / debug / escalate / checkpoint |
| parallel-set-selection | parallelism_class + write-set overlap → parallel-safe sets (feeds EPIC-017) |
| budget-governance | token/attempt budget tracking; when to halt vs escalate |
| escalation-triage | classify incoming escalations; human-gate vs retry vs re-scope |

### Debugger (+4, STORY-014.4)
| Skill | Codifies |
| --- | --- |
| root-cause-analysis | bisect discipline, stack-trace reading, log narrowing SOP |
| minimal-repair-pattern | smallest reversible fix; never rewrite the feature |
| failure-gene-authoring | emit well-formed genes; dedupe against the bank before writing |
| flaky-test-detection | re-run discrimination: real failure vs flake |

### Developer (+3 template skills, STORY-014.5)
| Skill | Codifies |
| --- | --- |
| crud-web-app-template | greenfield scaffold: Vite + React CRUD starter |
| rest-api-template | greenfield scaffold: Node/TS REST service starter |
| cli-tool-template | greenfield scaffold: Node/TS CLI starter |

Templates are the no-code product surface: users pick a template, not a stack.
Each template's scaffold must itself pass the quality bar (STORY-013.3).

### Planning Steward (+1, lands with EPIC-019)
| Skill | Codifies |
| --- | --- |
| defect-intake-triage | DefectReport → classify → reproduce-or-flag → minimal repair story |

### Shared (+1, lands with EPIC-015)
| Skill | Codifies |
| --- | --- |
| project-conventions | read the target project profile (naming, structure, lint) before proposing |

---

## Are skills enough? No — five capability layers

Skills are the **knowledge layer** only. A skill can tell an agent *how* to
localize a change; it cannot *run* a query, *remember* last week's failure,
*prove* its own quality, or *prevent* its owner from cheating. Each of those is
a different layer with a different owner:

| Layer | What it is | Owner mechanism | Where it lands |
| --- | --- | --- | --- |
| 1. 知識 Knowledge | SOPs, templates, AVOID notes | skill packages + role catalogs | EPIC-014 |
| 2. 工具 Tools | deterministic capabilities: codegraph engine, test runner, AST search | per-role tool registry behind the Permission Gateway | STORY-015.1, 015.2 |
| 3. 記憶 Memory | learned state: failure genes, skill `.memory.md`, project conventions profile | failure-bank (008.3) + project profile (015.4) |  EPIC-008 / 015 |
| 4. 評估 Evaluation | nothing trusted without evidence — for skills and models alike | skill-tester gate (014.1) + model shadow eval (018.3) | EPIC-014 / 018 |
| 5. 誠信 Integrity | honesty the agent cannot grant itself | harness gates: write-set enforcement, test-author separation (015.3), boundary tests | EPIC-015 + existing gates |

Design rule of thumb: **if it must be true even when the model is wrong, it
cannot live in a skill** — it must live in layers 2–5, owned by the
deterministic harness. Skills make agents capable; the other four layers make
them trustworthy.

---

## Mode-switching addendum (v25): greenfield vs brownfield

Agents are dual-mode; `task_class` on the story contract is the switch. The
differences are not stylistic — they invert the workflow:

| | Greenfield | Brownfield |
| --- | --- | --- |
| Planning Steward | invent: idea → PRD → architecture from templates | **understand first**: import repo read-only → recover as-is architecture + dependency map → author *delta* specs against existing symbols |
| Supervisor | write-set = create-set (disjoint by construction); parallelism high; risk = scope creep | write-set **derived from the impact set** (CodeGraph); hot-file overlap restricts parallelism; public-API/schema change forced `exclusive`; risk = regression |
| Validator | quality bar absolute (013.3) | quality bar **baseline-relative**: capture existing-test baseline pre-change, enforce zero new failures post-change |
| Documents | generate target docs from templates into the new repo | ingest existing docs read-only; write as-is recovery docs to a designated area; never overwrite existing docs outside the write-set; keep as-is and to-be separated |
| Ambiguity | "what do you want?" | also "**is this existing behavior intentional?**" |

Defects (EPIC-019) are a brownfield subspecies: repair stories carry
`task_class: brownfield` and inherit all the above.

### Brownfield skill additions (STORY-020.6)

| Role | Skill | Codifies |
| --- | --- | --- |
| planning-steward | architecture-recovery | survey an unknown repo: entry points, layering, dependency map |
| planning-steward | as-is-documentation | write recovery docs that describe what IS, never what should be |
| planning-steward | delta-spec-authoring | specs as diffs against existing symbols, with public-API-frozen constraints |
| supervisor | impact-aware-contract | derive tight write-sets from impact sets; classify regression risk |

## Model-routing trust classes (v30): generation vs assessment (STORY-030.8)

The live runs (2026-06-15) proved a structural rule, not a "smarter model" one: a
cheap model can **generate** code — it has downstream debug and review to catch
errors — but **assessment** (defining what is correct, authoring the acceptance
tests, judging completion) must run on a **strong, isolated** model regardless of
tier. The shipped default routing profile (`configs/model_routing.yaml`) encodes
this; it is a default, **not** a gate change, and operators tune cost via EPIC-021
settings without collapsing the separation.

| Trust class | Tier (default) | Roles | Why |
| --- | --- | --- | --- |
| **assessment** | strong | Planning Steward · Reviewer · **Assessor** | author/judge the correctness bar; blind spots here contaminate the standard meant to catch them |
| **coordination** | mid | Supervisor | routes and composes packets; no code authored |
| **generation** | cheap | Developer · Debugger | write code; downstream debug + review catch errors |

Invariant: the **Assessor must be cross-model from the Developer** (enforced in
`assessor-runtime`, STORY-030.3) — assessment ⊥ generation. In the default profile
this holds: assessor = strong (openai) ≠ developer = cheap (deepseek). Fixture and
scripted routing are unaffected (CI stays deterministic). Full rationale:
`07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md`.
