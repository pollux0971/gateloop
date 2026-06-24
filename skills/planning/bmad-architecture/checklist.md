# bmad-architecture completion checklist

The `architecture` stage is `done` only when every item passes under the
completion checker (directives after `::`).

- [ ] Summary section present and non-empty :: section: Summary
- [ ] Modules section present :: section: Modules
- [ ] Constraints section present :: section: Constraints
- [ ] Risks section present :: section: Risks
- [ ] modules map to the PRD's functional requirements (FR- coverage) :: contains: FR-
- [ ] module coverage is declared explicitly (covers FR-n) :: matches: covers\s+FR-
- [ ] no TBD / placeholder left :: no-tbd
