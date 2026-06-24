// @vitest-environment jsdom
//
// STORY-PWIRE.5 — DOM front-back integration LANDING TEST (barrier).
// Loads the REAL console.html into jsdom, evaluates the REAL planflow.js
// (window.__planflow), wires window.fetch to the IN-PROCESS api handlers from
// PWIRE.1/.2 (createPlanningFlowService — no network, no provider spend), drives
// the full brief→prd→architecture→epics flow, and asserts the rendered DOM
// node-flow reflects the live engine. Runs offline in CI. No product code touched.
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPlanningFlowService } from '../apps/api/src/planning';

const REPO = path.resolve(__dirname, '..'); // gateloop/
const consoleHtml = fs.readFileSync(path.join(REPO, 'apps', 'web', 'public', 'console.html'), 'utf8');
const planflowSrc = fs.readFileSync(path.join(REPO, 'apps', 'web', 'public', 'planflow.js'), 'utf8');

const GOOD_PRD = `# PRD
## Overview
problem. Primary users: operators. Scope — in scope: x; out of scope: y.
## Functional Requirements
FR-1: the system shall do X.
## Non-Functional Requirements
NFR-1: fast.
## Success criteria
- works
`;
const GOOD_ARCH = `# Architecture
## Summary
TS monorepo.
## Modules
- Engine — does it (covers FR-1)
## Constraints
- typescript monorepo.
## Risks
- latency.
`;
const GOOD_EPICS = `# Epics & Stories
## Epic E1 — Core
### Story E1.1 — Build
- size: single-session
- deps: none
- As a operator, I want X, so that Y.
- AC: Given a When b Then c.
- covers: FR-1
`;

let inProcessCalls = 0;
let networkAttempts = 0;

// Load the REAL console.html DOM with its scripts inert (we evaluate the real
// planflow.js ourselves and drive it), then wire window.fetch to a fresh
// in-process planning service. The script-strip is only the test's load step —
// no product file is modified.
const consoleNoScripts = consoleHtml.replace(/<script[\s\S]*?<\/script>/gi, '');

function mountConsole(): void {
  // ── behavior 1: load the REAL console.html structure into jsdom ──
  document.open();
  document.write(consoleNoScripts);
  document.close();
  // evaluate the REAL planflow.js (the product node-flow logic) into this window
  delete (window as any).__planflow;
  (window as any).__GATELOOP_API__ = '';
  (0, eval)(planflowSrc);

  // ── behavior 2 + 5: wire window.fetch to the in-process api (no network) ──
  const svc = createPlanningFlowService({ repo: REPO });
  inProcessCalls = 0;
  networkAttempts = 0;
  (window as any).fetch = (url: string, opts?: any) => {
    const u = String(url);
    if (u.endsWith('/api/planning/flow')) {
      inProcessCalls++;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(svc.getFlow()) });
    }
    if (u.endsWith('/api/planning/advance')) {
      inProcessCalls++;
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      return Promise.resolve({ ok: true, json: () => Promise.resolve(svc.advance(body)) });
    }
    networkAttempts++; // any other URL would be real network — forbidden in this offline test
    return Promise.reject(new Error('no network allowed: ' + u));
  };
}

beforeEach(() => mountConsole());

const statusOf = (stage: string) =>
  document.querySelector(`#steps .step[data-stage="${stage}"]`)?.getAttribute('data-status');
const allStatuses = () =>
  Array.from(document.querySelectorAll('#steps .step')).map((s) => s.getAttribute('data-status'));

describe('STORY-PWIRE.5 — DOM front-back integration landing test (barrier)', () => {
  it('jsdom_loads_real_console_html_invariant', () => {
    // the real console node-flow scaffolding is present in the loaded DOM
    expect(document.getElementById('steps')).not.toBeNull();
    expect(document.getElementById('step-mode')).not.toBeNull();
    expect(document.getElementById('stepper')).not.toBeNull();
    // and the real importable layer is available
    expect(typeof (window as any).__planflow.loadFlow).toBe('function');
  });

  it('window_fetch_wired_to_in_process_api_handlers_no_network_invariant', async () => {
    await (window as any).__planflow.loadFlow();
    expect(inProcessCalls).toBeGreaterThan(0); // the in-process handler served the request
    expect(networkAttempts).toBe(0); // nothing hit real network
    // the DOM was rendered from the live in-process engine (brief active initially)
    expect(statusOf('brief')).toBe('active');
    expect(allStatuses()).toEqual(['active', 'todo', 'todo', 'todo']);
  });

  it('advancing_flow_truly_updates_rendered_dom_nodes_invariant', async () => {
    await (window as any).__planflow.loadFlow();
    expect(statusOf('brief')).toBe('active');
    // advance the brief stage → the rendered DOM nodes actually change
    await (window as any).__planflow.advance({});
    expect(statusOf('brief')).toBe('done'); // node truly updated
    expect(statusOf('prd')).toBe('active');
    // advance the prd stage with a complete PRD → DOM advances again
    await (window as any).__planflow.advance({ doc: GOOD_PRD });
    expect(statusOf('prd')).toBe('done');
    expect(statusOf('architecture')).toBe('active');
  });

  it('full_pipeline_brief_to_epics_reflected_in_dom_node_states_invariant', async () => {
    await (window as any).__planflow.loadFlow();
    await (window as any).__planflow.advance({}); // brief -> prd
    await (window as any).__planflow.advance({ doc: GOOD_PRD }); // prd -> architecture
    await (window as any).__planflow.advance({ doc: GOOD_ARCH }); // architecture -> epics
    await (window as any).__planflow.advance({ doc: GOOD_EPICS }); // epics -> complete
    // the full pipeline end state is reflected in the DOM: every node done
    expect(allStatuses()).toEqual(['done', 'done', 'done', 'done']);
    expect(document.querySelectorAll('#steps .step.done').length).toBe(4);

    // a blocked advance does NOT corrupt the DOM (an incomplete doc on a fresh flow)
    mountConsole();
    await (window as any).__planflow.loadFlow();
    await (window as any).__planflow.advance({}); // brief -> prd
    await (window as any).__planflow.advance({ doc: '# PRD\n## Overview\nno FR here\n' }); // incomplete -> blocked
    expect(statusOf('prd')).toBe('active'); // stayed active; DOM reflects the refusal
    expect(statusOf('architecture')).toBe('todo');
  });

  it('integration_landing_test_runs_offline_in_ci_invariant', async () => {
    // drive the whole flow and assert NOTHING ever touched the network
    await (window as any).__planflow.loadFlow();
    await (window as any).__planflow.advance({});
    await (window as any).__planflow.advance({ doc: GOOD_PRD });
    await (window as any).__planflow.advance({ doc: GOOD_ARCH });
    await (window as any).__planflow.advance({ doc: GOOD_EPICS });
    expect(networkAttempts).toBe(0); // offline: every call served in-process
    expect(inProcessCalls).toBeGreaterThanOrEqual(5); // 1 load + 4 advances
  });
});
