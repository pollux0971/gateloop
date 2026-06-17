# Skill Runtime Model

How skills are described, retrieved, loaded, and gated at runtime. Schema:
`specs/skill_package.schema.json`. Lifecycle workflow:
`../workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`. Gating rules:
`12_RUNTIME_ALGORITHM_RULES.md` §9. Packages: `packages/skill-runtime`, `packages/skill-tester`.

## A skill package
A folder with: `SKILL.md` (the procedure), `skill.json` (manifest: id, agent_role,
description, version, status, tests, validation, depends_on, provenance,
failure_signatures, leakage_audit), `assets/` (templates), `tests/`, and `.memory.md`
(compact lessons). Status ∈ draft / needs_tests / registered / quarantined.

## Retrieval (dependency-ordered)
Skills form a typed-edge graph (depends_on / enhances). At runtime the harness selects
the relevant skills for the role+task and loads them in **dependency order** (a skill's
prerequisites first). Selection is structural (by role, task_class, and signals), not
fuzzy vector search — compact signals beat fuzzy retrieval at this layer.

## Loading & memory
On load, a skill contributes its `SKILL.md` procedure + any `AVOID:` lines from its
`.memory.md`. Skill memory is compact (2-level compression + pinning), and never carries
secrets.

## Gating (the safety rule)
A skill is **registered** to the Skill Bank only after: it ships `tests/`; its tests pass
in a disposable workspace; it survives the fresh-run robustness check (re-run from clean
state); and it passes the leakage audit (no env/secret/path leakage). On failure: iterate
**one change at a time**, re-test against the previous version; after the budget,
**quarantine** it and append an `AVOID:` note to its `.memory.md`. Promotion to a
production skill is a **human gate**.

## v0 scope
v0 implements: `loadSkillManifest()`, `validateSkillPackage()`,
`rejectSkillWithoutTests()`. Skill **evolution** (auto-improvement) is out of v0 scope.
