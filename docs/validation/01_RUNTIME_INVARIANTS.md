# Runtime Invariants

Properties that must hold at all times. Each is an assertion the harness self-checks
and the test suite verifies. A violated invariant halts the run.

1. **Propose-not-apply** — no repo write occurs except via the harness applying an
   agent proposal. (assert: no agent process has write access to the tree)
2. **Workspace-first** — every candidate change lives in a disposable workspace until
   promoted. (assert: applied diffs target a registry-confirmed workspace)
3. **Permission-before-apply** — every mutation has a prior `permission_*` allow event.
   (assert: no apply event without a preceding allow for the same action)
4. **Validation-before-completion** — no story is `checkpoint_ready` without a PASS
   validation record. (assert: checkpoint ⇒ ∃ passing validation_report)
5. **No self-grant / no self-complete** — no permission/write-set change or completion
   originates from an agent. (assert: such events have a human or harness actor)
6. **Raw-trace-preserved** — the event log is append-only; no rewrite/delete.
   (assert: monotonic sequence + previous_event_hash chain intact)
7. **Secret-hygiene** — no secret value appears in any context, log, or trace.
   (assert: redaction ran; scan finds no credential patterns)
8. **Budget-bounded** — counters are harness-maintained; reaching a limit stops retry.

Tested by `02_AGENT_BOUNDARY_TESTS.md`, `03_SECURITY_SCENARIO_TESTS.md`.
