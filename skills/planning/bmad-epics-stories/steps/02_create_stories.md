# Step 2 — Create fine-grained stories

For each epic, write stories. EACH story must declare, as machine-readable fields:

- `size: single-session` — completable by one developer in one session; if larger, split it.
- `deps:` — `none` or only EARLIER stories in the same epic (never a later one).
- an `As a … I want … so that …` statement.
- `AC: Given … When … Then …` acceptance criteria.
- `covers: FR-n` — which functional requirement(s) the story implements.
