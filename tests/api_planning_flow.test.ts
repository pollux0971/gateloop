import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { createPlanningFlowService } from '../apps/api/src/planning';

const REPO = path.resolve(__dirname, '..'); // gateloop/

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

describe('STORY-PWIRE.1 — GET /api/planning/flow (live engine)', () => {
  it('get_flow_returns_stages_with_status_skill_and_checklist_counts', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    const flow = svc.getFlow();
    expect(flow.stages.map((s) => s.id)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    for (const s of flow.stages) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('desc');
      expect(s).toHaveProperty('skill');
      expect(['todo', 'active', 'done']).toContain(s.status);
      expect(s).toHaveProperty('checklist_passed'); // null until evaluated
      expect(s).toHaveProperty('checklist_total');
    }
    // initial live state: brief active, rest todo
    expect(flow.stages.map((s) => s.status)).toEqual(['active', 'todo', 'todo', 'todo']);
    expect(flow.activeIndex).toBe(0);
  });

  it('get_flow_reads_live_engine_not_fixture', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    // advancing mutates the LIVE engine state — a fixture response would never change
    svc.advance({}); // brief -> done, prd active
    const flow = svc.getFlow();
    expect(flow.stages[0].status).toBe('done');
    expect(flow.stages[1].status).toBe('active');
    expect(flow.activeIndex).toBe(1);

    // and a passing PRD doc records live checklist counts on the now-evaluated stage
    svc.advance({ doc: GOOD_PRD }); // prd -> done
    const after = svc.getFlow();
    expect(after.stages[1].status).toBe('done');
    expect(after.stages[1].checklist_total).toBeGreaterThan(0); // live counts, not a static fixture
    expect(after.stages[1].checklist_passed).toBe(after.stages[1].checklist_total);

    // reset returns the live engine to the start (proves it is real engine state)
    svc.reset();
    expect(svc.getFlow().stages.map((s) => s.status)).toEqual(['active', 'todo', 'todo', 'todo']);
  });

  it('response_shape_matches_frontend_node_flow_contract', () => {
    const svc = createPlanningFlowService({ repo: REPO });
    const flow = svc.getFlow();
    // matches console.html renderSteps contract: mode/label + ordered stages with
    // exactly {id,name,desc,skill,status,checklist_passed,checklist_total}
    expect(flow.source).toBe('live');
    expect(typeof flow.mode).toBe('string');
    expect(typeof flow.label).toBe('string');
    const keys = Object.keys(flow.stages[0]).sort();
    expect(keys).toEqual(['checklist_passed', 'checklist_total', 'desc', 'id', 'name', 'skill', 'status']);
    // skill tag present for the doc-authoring stages, null for the brief
    expect(flow.stages.find((s) => s.id === 'prd')!.skill).toBe('bmad-prd');
    expect(flow.stages.find((s) => s.id === 'brief')!.skill).toBeNull();
  });
});
