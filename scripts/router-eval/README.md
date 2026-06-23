# router-eval — router efficiency evaluation (example)

A small harness to evaluate the multi-dimensional model router (P(success) − λ·cost)
on a planning idea: feed an idea, produce a fixed decomposition plan, run the router,
and report routing efficiency.

This is a **blank example**. Real evaluation inputs and outputs are local and not
committed (they are operator/run-specific):

- `idea.txt` — the planning idea to evaluate (provide your own; see `idea.example.txt`).
- `fixed-plan.json` — the fixed decomposition produced for the idea.
- `ROUTER_EFFICIENCY_REPORT.md` — the generated efficiency report for a run.
- `verify-routing.ts` — the eval driver.

To run your own evaluation, add an `idea.txt`, supply the eval driver, and inspect
the generated report. Keep run artifacts local (they are gitignored).
