import { describe, it, expect } from 'vitest';
import {
  parsePlanningWorkflow,
  initFlowState,
  flowSnapshot,
  advance,
  advanceGated,
  setStageChecklist,
  activeIndex,
  PlanningWorkflowStateError,
  type PlanningFlowState,
} from './workflow.js';
import { evaluateChecklist } from './checklist.js';

const CONFIG = parsePlanningWorkflow(`
mode: greenfield
label: GREENFIELD
stages:
  - id: brief
    name: 意圖
    desc: d0
    skill: ~
  - id: prd
    name: PRD
    desc: d1
    skill: bmad-prd
  - id: epics
    name: 切 story
    desc: d2
    skill: bmad-epics-stories
`);

const CHECKLIST = '- [ ] overview present :: section: Overview\n- [ ] no tbd :: no-tbd\n';
const COMPLETE_DOC = '# Brief\n## Overview\nA solid description.\n';
const INCOMPLETE_DOC = '# Brief\n## Overview\nstatus: TBD\n'; // has Overview but a TBD -> one item fails

const statusesOf = (s: PlanningFlowState): string[] => flowSnapshot(s).map((x) => x.status);

describe('STORY-PSKILL.4 — stage-done on checklist wired into PFLOW state', () => {
  it('stage_done_transition_requires_all_checklist_items_pass', () => {
    const s0 = initFlowState(CONFIG);
    const passing = evaluateChecklist(CHECKLIST, COMPLETE_DOC);
    expect(passing.complete).toBe(true);
    const res = advanceGated(s0, passing);
    expect(res.advanced).toBe(true);
    expect(res.from).toBe('brief');
    expect(res.to).toBe('prd');
    expect(statusesOf(res.state)).toEqual(['done', 'active', 'todo']);

    // a failing checklist does NOT transition the stage to done
    const failing = evaluateChecklist(CHECKLIST, INCOMPLETE_DOC);
    expect(failing.complete).toBe(false);
    const refused = advanceGated(s0, failing);
    expect(refused.advanced).toBe(false);
    expect(statusesOf(refused.state)).toEqual(['active', 'todo', 'todo']); // unchanged
  });

  it('advance_refused_with_failing_items_when_checklist_incomplete', () => {
    const s0 = initFlowState(CONFIG);
    const failing = evaluateChecklist(CHECKLIST, INCOMPLETE_DOC);
    const res = advanceGated(s0, failing);
    expect(res.advanced).toBe(false);
    expect(res.failingItems.length).toBeGreaterThan(0);
    // the failing item is the no-tbd one (doc has a TBD)
    expect(res.failingItems.some((it) => it.directive?.type === 'no-tbd')).toBe(true);
    // ordering untouched: brief still active, nothing advanced
    expect(activeIndex(res.state)).toBe(0);
    expect(statusesOf(res.state)).toEqual(['active', 'todo', 'todo']);
  });

  it('flow_snapshot_carries_checklist_passed_and_total_per_stage', () => {
    const s0 = initFlowState(CONFIG);
    // before any checklist: nulls
    expect(flowSnapshot(s0)[0].checklist_passed).toBeNull();
    expect(flowSnapshot(s0)[0].checklist_total).toBeNull();

    // a refused advance still records passed/total on the active stage
    const failing = evaluateChecklist(CHECKLIST, INCOMPLETE_DOC);
    const refused = advanceGated(s0, failing);
    const snap = flowSnapshot(refused.state);
    expect(snap[0].checklist_total).toBe(2);
    expect(snap[0].checklist_passed).toBe(1); // overview passes, no-tbd fails

    // setStageChecklist records progress without advancing
    const recorded = setStageChecklist(s0, 0, failing);
    expect(flowSnapshot(recorded)[0].checklist_passed).toBe(1);
    expect(statusesOf(recorded)).toEqual(['active', 'todo', 'todo']); // status unchanged

    // a passing advance records full passed/total on the now-done stage
    const passing = evaluateChecklist(CHECKLIST, COMPLETE_DOC);
    const done = advanceGated(s0, passing);
    expect(flowSnapshot(done.state)[0].checklist_passed).toBe(2);
    expect(flowSnapshot(done.state)[0].checklist_total).toBe(2);
  });

  it('ordering_from_pflow3_preserved_only_done_condition_added', () => {
    // PFLOW.3 ungated advance still works exactly as before (ordering unchanged)
    const s0 = initFlowState(CONFIG);
    const s1 = advance(s0);
    expect(statusesOf(s1)).toEqual(['done', 'active', 'todo']);

    // advanceGated still enforces ordering: completing the active stage activates
    // the NEXT one (never out of order), and over-advancing a complete flow throws
    const passing = evaluateChecklist(CHECKLIST, COMPLETE_DOC);
    let r = advanceGated(s0, passing); // brief -> done, prd active
    r = advanceGated(r.state, passing); // prd -> done, epics active
    r = advanceGated(r.state, passing); // epics -> done, complete
    expect(statusesOf(r.state)).toEqual(['done', 'done', 'done']);
    expect(r.to).toBeNull(); // no next stage
    expect(() => advanceGated(r.state, passing)).toThrow(PlanningWorkflowStateError); // complete -> throws
    expect(() => advanceGated(r.state, passing)).toThrow(/already complete/);

    // gated advance is pure: a refused attempt does not mutate the input state
    const before = JSON.stringify(s0);
    advanceGated(s0, evaluateChecklist(CHECKLIST, INCOMPLETE_DOC));
    expect(JSON.stringify(s0)).toBe(before);
  });
});
