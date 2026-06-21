---
name: ponytail-review
description: >
  Reviewer-side over-engineering pass: find what to delete. Reinvented standard
  library, unneeded dependencies, speculative abstractions, dead flexibility. One
  line per finding: location, what to cut, what replaces it. Complements the
  correctness review — this one only hunts complexity. Adapted for GateLoop:
  recommendations defer to the contract and the additive gate.
agent_role: reviewer
license: MIT
adapted_from: ponytail (MIT, Dietrich Gebert)
---

# Ponytail review (over-engineering only) — GateLoop reviewer skill

Review the diff for unnecessary complexity, nothing else. The diff's best outcome
is getting shorter. One line per finding: location, what to cut, what replaces it.
Correctness bugs, security holes, and performance are OUT of scope here — route them
to the normal review pass.

## Format

`L<line>: <tag> <what>. <replacement>.` (or `<file>:L<line>: …` for multi-file diffs).

Tags:

- `delete:` dead code, unused flexibility, a speculative feature. Replacement: nothing.
- `stdlib:` a hand-rolled thing the standard library already ships. Name the function.
- `native:` a dependency or code doing what the platform already does. Name the feature.
- `yagni:` an abstraction with one implementation, a config nobody sets, a layer with one caller.
- `shrink:` same logic, fewer lines. Show the shorter form.

End with the only metric that matters: `net: -<N> lines possible.` If there is
nothing to cut, say `Lean already. Ship.` and stop.

## Coordination with GateLoop's gates (so the review never causes a regression)

This skill recommends; it does not apply. Two bindings keep its advice safe:

1. **A recommendation to remove existing behavior is bounded by the contract.** Flag
   over-engineering freely, but a suggestion that would delete an existing exported
   function or behavior is only valid if the story's contract permits it —
   the additive gate will reject a patch that strips existing exports otherwise.
   Prefer "inline it", "collapse to one caller", "drop the unused branch" over
   "remove the public API".

2. **Never flag the ponytail minimum as bloat.** A single smoke test or an
   `assert`-based self-check is the required minimum ("lazy code without its check is
   unfinished"), not over-engineering. Do not recommend deleting the one runnable check
   a non-trivial change leaves behind.

## Boundaries

Read-only and advisory — list findings, do not apply fixes. Scope is over-engineering
and complexity only. Provider-agnostic: this is GateLoop reviewer guidance, injected
into the reviewer's prompt, not tied to any host or tool.
