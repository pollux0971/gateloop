# Step 3 — Validate coverage and dependencies

Before finishing, verify:

1. every PRD FR-n appears in at least one story's `covers:` line;
2. no story's `deps:` points to a later story in the same epic (backward-only);
3. every story declares `size: single-session` and has Given/When/Then AC.

The backend dry-run (PBMAD.4) re-checks these exhaustively against the generated
backlog.
