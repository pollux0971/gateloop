/**
 * STORY-PTEST.5 — Playwright config (optional full-browser E2E job).
 *
 * Runs the planning-flow E2E in headless Chromium. NO webServer: the spec loads the REAL
 * planflow.js into the page and fulfills the /api/planning/* requests IN-PROCESS via
 * page.route (the same in-process api the jsdom landing test wires to fetch), so there is
 * no network, no listening server, and no provider spend. This is a SEPARATE job from the
 * offline unit CI (root vitest + @gateloop/web vitest) — never part of `pnpm test`.
 * Run with `pnpm exec playwright test`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  reporter: 'line',
  use: { headless: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', headless: true } }],
});
