import { describe, it, expect } from 'vitest';
import {
  parsePlanningWorkflow,
  initFlowState,
  flowSnapshot,
  activeIndex,
  isComplete,
  canActivate,
  activateStage,
  advance,
  PlanningWorkflowStateError,
  type PlanningFlowState,
  type StageStatus,
} from './workflow.js';

const CONFIG = parsePlanningWorkflow(`
mode: greenfield
label: GREENFIELD
stages:
  - id: brief
    name: 意圖
    desc: 你想做什麼
    skill: ~
  - id: prd
    name: PRD
    desc: 需求草稿
    skill: bmad-prd
  - id: architecture
    name: 架構
    desc: 元件與分層
    skill: bmad-architecture
  - id: epics
    name: 切 story
    desc: 可驗收 backlog
    skill: bmad-epics-stories
`);

const statusesOf = (s: PlanningFlowState): StageStatus[] => flowSnapshot(s).map((x) => x.status);
const activeCount = (s: PlanningFlowState): number => statusesOf(s).filter((x) => x === 'active').length;

describe('STORY-PFLOW.3 — workflow state machine', () => {
  it('flow_state_snapshot_reports_per_stage_status_todo_active_done', () => {
    const s0 = initFlowState(CONFIG);
    const snap = flowSnapshot(s0);
    // snapshot is [{id,name,desc,skill,status}] in stage order
    expect(snap.map((x) => x.id)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    for (const item of snap) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('desc');
      expect(item).toHaveProperty('skill');
      expect(['todo', 'active', 'done']).toContain(item.status);
    }
    // initial: first active, rest todo
    expect(statusesOf(s0)).toEqual(['active', 'todo', 'todo', 'todo']);

    // after one advance: first done, second active
    const s1 = advance(s0);
    expect(statusesOf(s1)).toEqual(['done', 'active', 'todo', 'todo']);

    // a fully-advanced flow shows all done
    const sEnd = advance(advance(advance(s0)));
    expect(statusesOf(sEnd)).toEqual(['done', 'done', 'done', 'active']);
    const sComplete = advance(sEnd);
    expect(statusesOf(sComplete)).toEqual(['done', 'done', 'done', 'done']);
    expect(isComplete(sComplete)).toBe(true);
  });

  it('exactly_one_stage_active_at_a_time', () => {
    let s = initFlowState(CONFIG);
    // exactly one active at init and after every advance until complete
    expect(activeCount(s)).toBe(1);
    for (let step = 0; step < CONFIG.stages.length - 1; step++) {
      s = advance(s);
      expect(activeCount(s)).toBe(1);
      // and the active stage's predecessors are all done, successors all todo
      const ai = activeIndex(s);
      expect(statusesOf(s).slice(0, ai).every((x) => x === 'done')).toBe(true);
      expect(statusesOf(s).slice(ai + 1).every((x) => x === 'todo')).toBe(true);
    }
    // final advance completes the flow -> zero active (never two)
    s = advance(s);
    expect(activeCount(s)).toBe(0);
    expect(activeIndex(s)).toBe(-1);

    // ORDER ENFORCEMENT: cannot activate a later stage while predecessor not done
    const fresh = initFlowState(CONFIG);
    expect(canActivate(fresh, 2)).toBe(false); // architecture before prd done
    expect(() => activateStage(fresh, 2)).toThrow(PlanningWorkflowStateError);
    // reports the FIRST not-done predecessor (brief, still active) — accurate + clear
    expect(() => activateStage(fresh, 2)).toThrow(/predecessor 'brief' is 'active', not 'done'/);
    // the throw left state untouched (no mutation, still exactly one active at 0)
    expect(statusesOf(fresh)).toEqual(['active', 'todo', 'todo', 'todo']);
    expect(activeCount(fresh)).toBe(1);
  });

  it('advancing_active_stage_marks_done_and_next_active', () => {
    const s0 = initFlowState(CONFIG);
    expect(activeIndex(s0)).toBe(0);
    const s1 = advance(s0);
    expect(s1.statuses[0]).toBe('done'); // active stage marked done
    expect(s1.statuses[1]).toBe('active'); // next stage activated
    expect(activeIndex(s1)).toBe(1);

    // advancing a complete flow throws (no active stage to advance)
    const complete = advance(advance(advance(advance(s0))));
    expect(isComplete(complete)).toBe(true);
    expect(() => advance(complete)).toThrow(PlanningWorkflowStateError);
    expect(() => advance(complete)).toThrow(/already complete/);

    // canActivate becomes true for the next stage exactly once the predecessor is done
    expect(canActivate(s0, 1)).toBe(false); // prd not yet activatable (brief still active)
    expect(canActivate(s1, 2)).toBe(false); // architecture not yet (prd active not done)
    const s2 = advance(s1); // prd -> done, architecture active
    expect(s2.statuses[1]).toBe('done');
    expect(s2.statuses[2]).toBe('active');
  });

  it('state_machine_is_deterministic_same_input_same_state', () => {
    // identical drive sequence from identical init -> identical snapshots at every step
    const driveA = [initFlowState(CONFIG)];
    const driveB = [initFlowState(CONFIG)];
    for (let i = 0; i < CONFIG.stages.length; i++) {
      driveA.push(advance(driveA[driveA.length - 1]));
      driveB.push(advance(driveB[driveB.length - 1]));
    }
    for (let i = 0; i < driveA.length; i++) {
      expect(flowSnapshot(driveA[i])).toEqual(flowSnapshot(driveB[i]));
      expect(JSON.stringify(driveA[i])).toBe(JSON.stringify(driveB[i]));
    }

    // transitions are pure: advancing does not mutate the input state
    const s0 = initFlowState(CONFIG);
    const before = JSON.stringify(s0);
    advance(s0);
    expect(JSON.stringify(s0)).toBe(before);

    // activateStage is likewise pure (failed activation throws, no partial mutation)
    const s = initFlowState(CONFIG);
    const sBefore = JSON.stringify(s);
    try {
      activateStage(s, 3);
    } catch {
      /* expected */
    }
    expect(JSON.stringify(s)).toBe(sBefore);
  });
});
