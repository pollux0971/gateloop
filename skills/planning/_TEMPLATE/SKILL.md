---
name: _template
description: Scaffold for a doc-authoring planning skill — copy this directory, rename, and fill in.
role: Author
stage: ~
when: "describe when this skill drives its document stage"
inputs: "[prior stage artifacts this skill consumes, e.g. brief]"
---

# Doc-authoring skill (template)

This is the scaffold every doc-authoring planning skill follows (STORY-PSKILL.1).
Copy `skills/planning/_TEMPLATE/` to `skills/planning/<your-skill>/`, then:

1. Set the YAML frontmatter above: `name`, `description`, `role` are **required**;
   `stage`, `when`, `inputs` are optional metadata the runtime preserves.
2. Author the ordered, just-in-time steps under `steps/` (one file per step,
   named `NN_*.md` so they enumerate in order).
3. Define the output document shape in `template.md`.
4. Define the COMPLETION conditions in `checklist.md` — the stage becomes `done`
   only when every checklist item passes (wired in PSKILL.4).

Per ADR-0013 (operator-trust) a skill registers unvalidated — there is no
test-gate — but a missing required file or malformed frontmatter is a hard load
error (visible, never silent).
