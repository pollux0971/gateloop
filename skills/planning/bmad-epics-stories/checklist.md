# bmad-epics-stories completion checklist

The `epics` stage is `done` only when every item passes under the completion
checker (directives after `::`). The fine-grainedness rules are encoded here; the
backend dry-run (PBMAD.4) re-checks them exhaustively against the generated backlog.

- [ ] epics and stories present :: contains: Story
- [ ] every story is single-dev-session sized :: contains: size: single-session
- [ ] dependencies declared, backward-only within an epic (no future dependency) :: contains: deps:
- [ ] acceptance criteria use Given/When/Then :: matches: Given\s+.+When\s+.+Then
- [ ] stories cover the PRD functional requirements :: contains: covers: FR-
- [ ] no TBD / placeholder left :: no-tbd
