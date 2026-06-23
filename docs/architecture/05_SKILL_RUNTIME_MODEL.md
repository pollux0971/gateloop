# Skill Runtime Model

How skills are described, retrieved, and loaded at runtime. Schema:
`specs/skill_package.schema.json`. Lifecycle workflow:
`../workflows/08_SKILL_LIFECYCLE_RUNTIME_WORKFLOW.md`. Registration policy:
`12_RUNTIME_ALGORITHM_RULES.md` §9. Packages: `packages/skill-runtime`, `packages/skill-tester`.

> **ADR-0013 (operator-trust):** the ADR-0008 test-gate is **retired**. Under the
> operator-trust execution model a user's skill installs and runs **unvalidated** — see
> "Registration" below. Tests are an **optional self-check**, never a gate; there is no
> quarantine and no leakage-audit blocking registration. This doc states exactly what now
> happens and claims no validation that no longer occurs (leave no phantom defense).

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

## Registration (operator-trust — no test-gate)
Per ADR-0013 §2, a skill the operator adds is **registered as-is, unvalidated**. There is
**no test requirement, no quarantine, and no leakage-audit blocking registration** — the
operator trusts their own skills, the same risk level as running any local AI coding tool
with auto-run. `canRegisterSkill()` permits unconditionally.

The test-runner machinery is **kept, as an OPTIONAL self-check** the operator may run: its
unit tests, the fresh-run robustness check, and the leakage/OOD audit all still exist in
`packages/skill-tester` and remain useful quality signals — they simply **do not gate**
registration any more. `validateSkillPackage()` / `rejectSkillWithoutTests()` still report
whether a skill ships tests, but a negative result is advisory only. Promotion of the
whole harness to a stable branch remains a human gate (that is a real boundary crossing,
unrelated to the retired skill test-gate).

## v0 scope
v0 implements: `loadSkillManifest()`, `validateSkillPackage()`,
`rejectSkillWithoutTests()` (now the optional self-check), and `canRegisterSkill()` (the
operator-trust permit). Skill **evolution** (auto-improvement) is out of v0 scope.
