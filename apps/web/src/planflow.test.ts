import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.resolve(__dirname, '..', 'public');
const planflowSrc = fs.readFileSync(path.join(PUBLIC, 'planflow.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(PUBLIC, 'console.html'), 'utf8');

const LIVE_FLOW = {
  source: 'live',
  mode: 'greenfield',
  label: 'GREENFIELD',
  activeIndex: 1,
  stages: [
    { id: 'brief', name: 'Brief', desc: 'intent', skill: null, status: 'done', checklist_passed: null, checklist_total: null },
    { id: 'prd', name: 'PRD', desc: 'requirements', skill: 'bmad-prd', status: 'active', checklist_passed: 3, checklist_total: 5 },
    { id: 'architecture', name: 'Arch', desc: 'modules', skill: 'bmad-architecture', status: 'todo', checklist_passed: null, checklist_total: null },
    { id: 'epics', name: 'Epics', desc: 'backlog', skill: 'bmad-epics-stories', status: 'todo', checklist_passed: null, checklist_total: null },
  ],
};
const okFetch = () => Promise.resolve({ json: () => Promise.resolve(LIVE_FLOW) } as Response);
const failFetch = () => Promise.reject(new Error('offline'));

declare global {
  // eslint-disable-next-line no-var
  var __planflow: any;
}

beforeEach(() => {
  document.body.innerHTML =
    '<div class="stepper"><span class="md" id="step-mode">GREENFIELD</span><div id="steps"></div></div>';
  delete (window as any).__planflow;
  // load the real planflow.js browser global into this jsdom window
  (0, eval)(planflowSrc);
});

const steps = () => document.querySelectorAll('#steps .step');

describe('STORY-PWIRE.3 — node flow → live data (window.__planflow)', () => {
  it('node_flow_renders_from_live_flow_endpoint', async () => {
    await (window as any).__planflow.loadFlow({ fetch: okFetch, base: '' });
    expect(steps().length).toBe(4); // rendered from the live endpoint payload
    expect(steps()[0].getAttribute('data-status')).toBe('done');
    expect(steps()[1].getAttribute('data-status')).toBe('active');
    expect(steps()[1].classList.contains('active')).toBe(true); // same visual .step class
    expect(document.getElementById('step-mode')!.getAttribute('data-source')).toBe('live');
  });

  it('each_node_shows_status_skill_and_checklist_count', async () => {
    await (window as any).__planflow.loadFlow({ fetch: okFetch, base: '' });
    const prd = document.querySelector('#steps .step[data-stage="prd"]')!;
    expect(prd.getAttribute('data-status')).toBe('active'); // status
    expect(prd.querySelector('.nf-skill')!.textContent).toBe('bmad-prd'); // skill tag
    expect(prd.querySelector('.nf-check')!.textContent).toBe('3/5'); // checklist count
    // the brief node has no skill/checklist tags
    const brief = document.querySelector('#steps .step[data-stage="brief"]')!;
    expect(brief.querySelector('.nf-skill')).toBeNull();
  });

  it('demo_fallback_renders_when_api_offline', async () => {
    const used = await (window as any).__planflow.loadFlow({ fetch: failFetch, base: '' });
    expect(used.source).toBe('sample'); // DEMO_FLOW returned
    expect(steps().length).toBe(4); // still renders the node-flow from DEMO
    expect(document.getElementById('step-mode')!.getAttribute('data-source')).toBe('demo');
    // also falls back when there is no fetch at all
    document.getElementById('steps')!.innerHTML = '';
    await (window as any).__planflow.loadFlow({ fetch: null, base: '' });
    expect(steps().length).toBe(4);
  });

  it('renderSteps_and_fetch_refactored_into_importable_function_for_tests', () => {
    // importable surface for PWIRE.5's DOM test
    const pf = (window as any).__planflow;
    expect(typeof pf.renderFlow).toBe('function');
    expect(typeof pf.loadFlow).toBe('function');
    expect(typeof pf.advance).toBe('function');
    expect(Array.isArray(pf.DEMO_FLOW.stages)).toBe(true);
    // renderFlow is callable directly with a flow object (no fetch needed)
    pf.renderFlow(document.getElementById('steps'), LIVE_FLOW);
    expect(steps().length).toBe(4);
    // console.html wires the importable script + live endpoint (data layer, DEMO kept)
    expect(consoleHtml).toContain('planflow.js');
    expect(consoleHtml).toContain('__planflow');
    expect(consoleHtml).toMatch(/loadFlow\(\)/);
  });
});
