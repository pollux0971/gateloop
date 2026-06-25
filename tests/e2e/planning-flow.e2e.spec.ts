/**
 * STORY-PTEST.5 — Full-browser E2E (headless Chromium) for the planning node-flow.
 *
 * Loads the REAL apps/web/public/planflow.js into a real browser and fulfills the
 * /api/planning/* requests IN-PROCESS via page.route, backed by the REAL planning api
 * (createPlanningFlowService, scripted author — no provider, no key, no spend). This is the
 * full-browser complement to the jsdom landing test: live render, advance updates the DOM,
 * and DEMO fallback when the api is down. No listening server (so it runs anywhere).
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlanningFlowService, type PlanningFlowService } from '../../apps/api/src/planning';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..'); // gateloop/
const PLANFLOW_JS = fs.readFileSync(path.join(REPO, 'apps', 'web', 'public', 'planflow.js'), 'utf8');

// the node-flow host page: the same #stepper/#step-mode/#steps contract console.html uses,
// with the REAL planflow.js inlined and an api base that page.route will intercept.
const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<script>window.__GATELOOP_API__ = 'http://e2e.local';</script>
</head><body>
<div class="stepper"><span class="md" id="step-mode">GREENFIELD</span><div id="steps"></div></div>
<script>${PLANFLOW_JS}</script>
<script>document.addEventListener('DOMContentLoaded', function(){ if(window.__planflow) window.__planflow.loadFlow(); });</script>
</body></html>`;

/** Wire page.route to fulfill the planning api from a fresh in-process service. */
async function wireApi(page: Page, svc: PlanningFlowService, opts: { flowDown?: boolean } = {}): Promise<void> {
  await page.route('**/api/planning/flow', (route: Route) => {
    if (opts.flowDown) return route.abort();
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(svc.getFlow()) });
  });
  await page.route('**/api/planning/advance', async (route: Route) => {
    const body = route.request().postDataJSON() ?? {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(svc.advance(body)) });
  });
  await page.route('**/api/planning/author', async (route: Route) => {
    const body = route.request().postDataJSON() ?? {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(await svc.author(body)) });
  });
}

/** Load the host page (with planflow.js) after the api routes are wired. */
async function loadApp(page: Page): Promise<void> {
  await page.goto('about:blank');
  await page.setContent(HOST_PAGE, { waitUntil: 'load' });
}

test('playwright_serves_real_app_and_drives_planning_flow_in_headless_browser', async ({ page }) => {
  await wireApi(page, createPlanningFlowService({ repo: REPO }));
  await loadApp(page);
  // the real planflow.js rendered the live node-flow into #steps.
  await expect(page.locator('#steps .step')).toHaveCount(4);
  await expect(page.locator('#step-mode')).toHaveAttribute('data-source', 'live');
  await expect(page.locator('#steps .step[data-stage="brief"]')).toBeVisible();
  await expect(page.locator('#steps .step[data-stage="epics"]')).toBeVisible();
});

test('node_flow_renders_live_and_advances_update_dom_in_real_browser', async ({ page }) => {
  await wireApi(page, createPlanningFlowService({ repo: REPO }));
  await loadApp(page);
  await expect(page.locator('#steps .step[data-stage="brief"]')).toHaveAttribute('data-status', 'active');
  await expect(page.locator('#steps .step[data-stage="prd"]')).toHaveAttribute('data-status', 'todo');

  // advance the brief stage through the REAL api (scripted author) — the DOM updates live.
  await page.evaluate(() => (window as unknown as { __planflow: { chatAuthor: (o: unknown) => Promise<unknown> } }).__planflow.chatAuthor({ idea: 'A tiny URL shortener.' }));
  await expect(page.locator('#steps .step[data-stage="brief"]')).toHaveAttribute('data-status', 'done');
  await expect(page.locator('#steps .step[data-stage="prd"]')).toHaveAttribute('data-status', 'active');
});

test('demo_fallback_renders_in_real_browser_when_api_down', async ({ page }) => {
  // the live flow fetch fails → planflow falls back to the DEMO flow + demo badge.
  await wireApi(page, createPlanningFlowService({ repo: REPO }), { flowDown: true });
  await loadApp(page);
  await expect(page.locator('#step-mode')).toHaveAttribute('data-source', 'demo');
  await expect(page.locator('#steps .step')).toHaveCount(4); // DEMO_FLOW still renders 4 nodes
});

test('browser_e2e_uses_scripted_author_no_real_spend', async ({ page }) => {
  // record any request to a real LLM provider host — there must be none.
  const providerHits: string[] = [];
  page.on('request', (r) => {
    if (/openai|anthropic|deepseek|googleapis/i.test(r.url())) providerHits.push(r.url());
  });
  await wireApi(page, createPlanningFlowService({ repo: REPO }));
  await loadApp(page);
  // authoring with the default (scripted) mode — no key in the body, no provider call.
  await page.evaluate(() => (window as unknown as { __planflow: { chatAuthor: (o: unknown) => Promise<unknown> } }).__planflow.chatAuthor({ idea: 'x' }));
  await expect(page.locator('#steps .step[data-stage="brief"]')).toHaveAttribute('data-status', 'done');
  expect(providerHits).toEqual([]);
});

test('playwright_dependency_change_confined_to_this_write_set', () => {
  // the dependency + config artifacts live ONLY within PTEST.5's declared write-set.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  expect(pkg.devDependencies['@playwright/test']).toBeTruthy();
  expect(fs.existsSync(path.join(REPO, 'playwright.config.ts'))).toBe(true);
  expect(fs.existsSync(path.join(REPO, 'tests', 'e2e', 'planning-flow.e2e.spec.ts'))).toBe(true);
  // NOT wired into the offline unit CI (the e2e spec is *.e2e.spec.ts, not *.test.ts).
  expect(pkg.scripts.test).not.toMatch(/playwright/);
  expect(pkg.scripts['test:ci'] ?? '').not.toMatch(/playwright/);
});
