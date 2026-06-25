/**
 * STORY-PTEST.7 — Coverage gate config for the planning packages.
 *
 * Run with `pnpm test:coverage:planning` (vitest run --coverage --config
 * scripts/coverage.config.ts). The FLOORS below fail the run on regression (per
 * docs/architecture/29_PLANNING_TEST_STRATEGY.md §3.2). Measured baseline (2026-06-25):
 * planning-steward/src ~95.7% lines / 84% branches / 100% funcs; apps/api/src/planning.ts
 * 100% lines / 93% branches. The floors sit below the baseline so CI fails only on a real
 * regression, not on noise.
 *
 * SCOPE: only the node-instrumentable product modules the root vitest actually runs —
 * the @gateloop/planning-steward engine/checker/author core and the apps/api planning
 * service. apps/web/public/planflow.js is a BROWSER global loaded via <script>/eval in the
 * jsdom tests (planflow*.test.ts in the @gateloop/web suite + the pwire_dom_landing DOM
 * test); it is exercised behaviorally there but is not a v8-instrumentable node module, so
 * it is intentionally OUT of this v8 line-coverage gate. The gated runner
 * (tests/pllm6_real_epics_run.ts) is excluded — it never runs in CI.
 */
import { defineConfig } from 'vitest/config';

export const PLANNING_COVERAGE_THRESHOLDS = {
  'packages/planning-steward/src/**': { lines: 90, statements: 90, functions: 90, branches: 78 },
  'apps/api/src/planning.ts': { lines: 95, statements: 95, functions: 95, branches: 85 },
};

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/planning-steward/src/**', 'apps/api/src/planning.ts'],
      // never measure tests, the gated runner, or generated output.
      exclude: ['**/*.test.ts', 'tests/pllm6_real_epics_run.ts', '**/dist/**'],
      thresholds: PLANNING_COVERAGE_THRESHOLDS,
      reporter: ['text-summary'],
    },
  },
});
