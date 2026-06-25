/**
 * STORY-PTEST.7 — Coverage gate config for the planning packages.
 *
 * Used by `pnpm test:coverage:planning` (vitest run --coverage --config
 * scripts/coverage.config.ts). The line/statement FLOORS below fail the run on
 * regression (per docs/architecture/29_PLANNING_TEST_STRATEGY.md §3.2). The provider
 * `@vitest/coverage-v8` is an offline-absent dev dependency; enable the actual coverage
 * RUN with a one-time `pnpm add -w -D @vitest/coverage-v8` (the thresholds here are the
 * standing enforcement config, machine-checked by tests/ptest7_ci_gate.test.ts even
 * before the provider is installed). The gated runner (tests/pllm6_real_epics_run.ts)
 * is EXCLUDED from coverage — it never runs in CI and would never be exercised offline.
 */
import { defineConfig } from 'vitest/config';

export const PLANNING_COVERAGE_THRESHOLDS = {
  'packages/planning-steward/src/**': { lines: 90, statements: 90, functions: 85, branches: 75 },
  'apps/api/src/planning.ts': { lines: 85, statements: 85, functions: 80, branches: 70 },
  'apps/web/public/planflow.js': { lines: 75, statements: 75, functions: 70, branches: 60 },
};

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/planning-steward/src/**', 'apps/api/src/planning.ts', 'apps/web/public/planflow.js'],
      // never measure tests, the gated runner, or generated output.
      exclude: ['**/*.test.ts', 'tests/pllm6_real_epics_run.ts', '**/dist/**'],
      thresholds: PLANNING_COVERAGE_THRESHOLDS,
    },
  },
});
