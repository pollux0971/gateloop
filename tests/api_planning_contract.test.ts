/**
 * STORY-PTEST.2 — API CONTRACT tests for the planning service.
 *
 * Asserts the EXACT declared shapes (PlanningFlowResponse / PlanningAdvanceResponse and
 * the per-stage FlowStageSnapshot) and EVERY documented path of /flow + /advance — brief
 * ungated, skill-stage success, blocked-with-failing-items, already-complete, and reset.
 * Calls the in-process service factory directly (no network); a throwing global fetch
 * proves the contract path never touches the wire. Complements (does not replace) the
 * PWIRE.1/.2 tests, which assert behavior; this asserts shape.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'node:path';
import { createPlanningFlowService } from '../apps/api/src/planning';

const REPO = path.resolve(__dirname, '..'); // gateloop/

const GOOD_PRD = `# PRD
## Overview
Problem. Primary users: operators. Scope — in scope: x; out of scope: y.
## Functional Requirements
FR-1: the system shall do X.
## Non-Functional Requirements
NFR-1: fast.
## Success criteria
- works
`;
const BAD_PRD = '# PRD\n## Overview\nusers and scope.\n## Non-Functional Requirements\nx\n## Success criteria\ny\n'; // no FR section

const STAGE_KEYS = ['id', 'name', 'desc', 'skill', 'status', 'checklist_passed', 'checklist_total'].sort();
const FLOW_KEYS = ['source', 'mode', 'label', 'activeIndex', 'stages'].sort();
const ADVANCE_KEYS = ['advanced', 'from', 'to', 'blocked_reason', 'failing_items', 'flow'].sort();
const ITEM_KEYS = ['id', 'text', 'directive', 'evaluable', 'pass'].sort();

describe('STORY-PTEST.2 — planning API contract', () => {
  it('get_flow_response_matches_declared_shape', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    const flow = svc.getFlow();

    expect(Object.keys(flow).sort()).toEqual(FLOW_KEYS);
    expect(flow.source).toBe('live');
    expect(typeof flow.mode).toBe('string');
    expect(typeof flow.label).toBe('string');
    expect(typeof flow.activeIndex).toBe('number');
    expect(Array.isArray(flow.stages)).toBe(true);
    expect(flow.stages.length).toBeGreaterThan(0);

    for (const s of flow.stages) {
      expect(Object.keys(s).sort()).toEqual(STAGE_KEYS);
      expect(typeof s.id).toBe('string');
      expect(typeof s.name).toBe('string');
      expect(typeof s.desc).toBe('string');
      expect(s.skill === null || typeof s.skill === 'string').toBe(true);
      expect(['todo', 'active', 'done']).toContain(s.status);
      expect(s.checklist_passed === null || typeof s.checklist_passed === 'number').toBe(true);
      expect(s.checklist_total === null || typeof s.checklist_total === 'number').toBe(true);
    }
    // the pipeline is the declared brief→prd→architecture→epics order.
    expect(flow.stages.map((s) => s.id)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    // exactly one active stage at the start (the brief).
    expect(flow.stages.filter((s) => s.status === 'active').map((s) => s.id)).toEqual(['brief']);
  });

  it('advance_success_and_brief_ungated_paths_covered', () => {
    const svc = createPlanningFlowService({ repo: REPO });

    const brief = svc.advance({}); // brief: ungated (no skill, no doc needed)
    expect(Object.keys(brief).sort()).toEqual(ADVANCE_KEYS);
    expect(brief.advanced).toBe(true);
    expect(brief.from).toBe('brief');
    expect(brief.to).toBe('prd');
    expect(brief.blocked_reason).toBeNull();
    expect(brief.failing_items).toEqual([]);
    expect(brief.flow.stages.find((s) => s.id === 'brief')!.status).toBe('done');

    const prd = svc.advance({ doc: GOOD_PRD }); // skill stage success
    expect(prd.advanced).toBe(true);
    expect(prd.from).toBe('prd');
    expect(prd.to).toBe('architecture');
    expect(prd.failing_items).toEqual([]);
    expect(prd.flow.stages.find((s) => s.id === 'prd')!.status).toBe('done');
    expect(prd.flow.stages.find((s) => s.id === 'architecture')!.status).toBe('active');
  });

  it('advance_blocked_returns_nonempty_failing_items_and_reason', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    svc.advance({}); // → prd active
    const blocked = svc.advance({ doc: BAD_PRD });

    expect(Object.keys(blocked).sort()).toEqual(ADVANCE_KEYS);
    expect(blocked.advanced).toBe(false);
    expect(blocked.blocked_reason).toMatch(/checklist \d+\/\d+ — not complete/);
    expect(blocked.failing_items.length).toBeGreaterThan(0);
    // every failing item matches the declared ChecklistItem shape and is genuinely failing.
    for (const it of blocked.failing_items) {
      expect(Object.keys(it).sort()).toEqual(ITEM_KEYS);
      expect(typeof it.id).toBe('string');
      expect(typeof it.text).toBe('string');
      expect(it.pass).toBe(false);
    }
    // the stage did NOT advance.
    expect(blocked.flow.stages.find((s) => s.id === 'prd')!.status).toBe('active');
    expect(blocked.flow.stages.find((s) => s.id === 'architecture')!.status).toBe('todo');
  });

  it('advance_already_complete_and_reset_paths_covered', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    // docs that genuinely satisfy each stage's checklist → the flow truly completes.
    const ARCH = `# Architecture
## Summary
A layered CLI design for operators.
## Modules
module-api covers FR-1.
## Constraints
offline only.
## Risks
data loss on crash.
`;
    const EPICS = `# Epics
## Epic E1
### Story E1.1
- size: single-session
- deps: none
- covers: FR-1
- As a user, I want X so that Y.
- AC: Given a When b Then c.
`;
    expect(svc.advance({}).advanced).toBe(true); // brief → prd
    expect(svc.advance({ doc: GOOD_PRD }).advanced).toBe(true); // prd → architecture
    expect(svc.advance({ doc: ARCH }).advanced).toBe(true); // architecture → epics
    const epics = svc.advance({ doc: EPICS }); // epics → (complete)
    expect(epics.advanced).toBe(true);
    expect(epics.to).toBeNull(); // last stage → no next

    // the whole flow is now done.
    expect(svc.getFlow().stages.every((s) => s.status === 'done')).toBe(true);

    // already-complete contract: a further advance is a clean no-op, not a throw.
    const done = svc.advance({ doc: EPICS });
    expect(done.advanced).toBe(false);
    expect(done.blocked_reason).toBe('flow already complete');
    expect(done.from).toBeNull();
    expect(done.to).toBeNull();
    expect(done.failing_items).toEqual([]);

    // reset() returns to the start: brief active, nothing done.
    svc.reset();
    const after = svc.getFlow();
    expect(after.activeIndex).toBe(0);
    expect(after.stages.find((s) => s.id === 'brief')!.status).toBe('active');
    expect(after.stages.filter((s) => s.status === 'done')).toEqual([]);
  });

  it('contract_tests_call_in_process_service_no_network', () => {
    // Disable the global fetch — the in-process service must not need it.
    const savedFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = () => {
      throw new Error('network call attempted in a contract test');
    };
    try {
      const svc = createPlanningFlowService({ repo: REPO });
      const flow = svc.getFlow();
      expect(flow.source).toBe('live');
      const r = svc.advance({});
      expect(r.advanced).toBe(true);
      // it worked with fetch disabled → the contract path is entirely in-process.
    } finally {
      (globalThis as { fetch?: unknown }).fetch = savedFetch;
    }
  });
});
