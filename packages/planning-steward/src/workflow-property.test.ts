/**
 * STORY-PTEST.3 — Property / invariant tests over the PFLOW engine (randomized, seeded).
 *
 * Generalizes PFLOW.4's hand-picked barrier to MANY inputs: with a seeded PRNG we build
 * random stage configs and random advance/activate sequences and assert the engine's
 * guarantees ALWAYS hold. Seeded so any failure reproduces from the printed seed.
 */
import { describe, it, expect } from 'vitest';
import {
  initFlowState,
  advance,
  activeIndex,
  isComplete,
  canActivate,
  activateStage,
  flowSnapshot,
  setStageChecklist,
  advanceGated,
  PlanningWorkflowStateError,
  type PlanningWorkflowConfig,
  type PlanningFlowState,
} from './workflow.js';
import type { ChecklistResult } from './checklist.js';

// ── seeded PRNG (mulberry32) — pure, deterministic, no deps ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

const SKILLS = [null, 'bmad-prd', 'bmad-architecture', 'bmad-epics-stories'];

function randomConfig(rng: () => number): PlanningWorkflowConfig {
  const n = randInt(rng, 2, 7);
  const stages = Array.from({ length: n }, (_, i) => ({
    id: `stage-${i}`,
    name: `Stage ${i}`,
    desc: `desc ${i}`,
    skill: SKILLS[randInt(rng, 0, SKILLS.length - 1)],
  }));
  return { mode: 'greenfield', label: 'GREENFIELD', stages };
}

const activeCount = (s: PlanningFlowState) => s.statuses.filter((x) => x === 'active').length;
const STATUSES = new Set(['todo', 'active', 'done']);

const RUNS = 250; // property runs per invariant
const BASE_SEED = 0x5eed; // recorded for reproducibility

describe('STORY-PTEST.3 — PFLOW engine property/invariant tests (seeded)', () => {
  it('randomized_sequences_never_produce_two_active_stages_invariant', () => {
    for (let r = 0; r < RUNS; r++) {
      const seed = BASE_SEED + r;
      const rng = mulberry32(seed);
      const cfg = randomConfig(rng);
      let state = initFlowState(cfg);
      expect(activeCount(state), `seed ${seed} init`).toBe(1); // exactly one at start
      // advance to completion; at NO point may there be two active stages.
      let guard = 0;
      while (!isComplete(state) && guard++ < 100) {
        state = advance(state);
        expect(activeCount(state), `seed ${seed} step ${guard}`).toBeLessThanOrEqual(1);
      }
      expect(activeCount(state), `seed ${seed} done`).toBe(0); // complete → zero active
    }
  });

  it('randomized_sequences_never_activate_before_predecessor_done_invariant', () => {
    for (let r = 0; r < RUNS; r++) {
      const seed = BASE_SEED + 1000 + r;
      const rng = mulberry32(seed);
      const cfg = randomConfig(rng);
      let state = initFlowState(cfg);
      let guard = 0;
      while (!isComplete(state) && guard++ < 100) {
        const ai = activeIndex(state);
        // the active stage's predecessors are ALL done (order never violated).
        expect(state.statuses.slice(0, ai).every((s) => s === 'done'), `seed ${seed}`).toBe(true);
        // poke a random index: activateStage must THROW for every illegal target
        // (out of range, the active stage, a done stage, or a not-yet-reachable todo).
        const probe = randInt(rng, -1, cfg.stages.length);
        if (!canActivate(state, probe)) {
          expect(() => activateStage(state, probe), `seed ${seed} probe ${probe}`).toThrow(
            PlanningWorkflowStateError,
          );
        }
        // canActivate must agree with the predicate: todo + all predecessors done.
        for (let i = 0; i < cfg.stages.length; i++) {
          const legal = state.statuses[i] === 'todo' && state.statuses.slice(0, i).every((s) => s === 'done');
          expect(canActivate(state, i), `seed ${seed} canActivate ${i}`).toBe(legal);
        }
        state = advance(state);
      }
    }
  });

  it('advancing_past_end_never_wraps_or_corrupts_over_random_runs_invariant', () => {
    for (let r = 0; r < RUNS; r++) {
      const seed = BASE_SEED + 2000 + r;
      const rng = mulberry32(seed);
      const cfg = randomConfig(rng);
      const n = cfg.stages.length;
      let state = initFlowState(cfg);
      let guard = 0;
      while (!isComplete(state) && guard++ < 100) {
        state = advance(state);
        // structure never corrupts: count constant, statuses valid, ids preserved.
        expect(state.statuses.length, `seed ${seed}`).toBe(n);
        expect(state.stages.length, `seed ${seed}`).toBe(n);
        expect(state.statuses.every((s) => STATUSES.has(s)), `seed ${seed}`).toBe(true);
        expect(state.stages.map((s) => s.id)).toEqual(cfg.stages.map((s) => s.id));
      }
      // past the end: advancing a complete flow THROWS (never wraps to index 0).
      expect(isComplete(state)).toBe(true);
      expect(activeIndex(state)).toBe(-1);
      expect(() => advance(state), `seed ${seed} past-end`).toThrow(PlanningWorkflowStateError);
      // still complete + uncorrupted after the rejected advance.
      expect(isComplete(state)).toBe(true);
      expect(state.statuses.length).toBe(n);
    }
  });

  it('snapshot_checklist_counts_always_internally_consistent_invariant', () => {
    for (let r = 0; r < RUNS; r++) {
      const seed = BASE_SEED + 3000 + r;
      const rng = mulberry32(seed);
      const cfg = randomConfig(rng);
      let state = initFlowState(cfg);

      // attach random (but internally valid) checklist results to random stages.
      const attachCount = randInt(rng, 0, cfg.stages.length);
      for (let k = 0; k < attachCount; k++) {
        const i = randInt(rng, 0, cfg.stages.length - 1);
        const total = randInt(rng, 0, 9);
        const passed = total === 0 ? 0 : randInt(rng, 0, total);
        const result: ChecklistResult = {
          items: Array.from({ length: total }, (_, j) => ({
            id: `i-${j}`,
            text: `item ${j}`,
            directive: null,
            evaluable: false,
            pass: j < passed,
          })),
          passed,
          total,
          complete: total > 0 && passed === total,
        };
        state = setStageChecklist(state, i, result);
      }

      // also drive a gated advance with a random checklist (exercises advanceGated's record).
      const gateTotal = randInt(rng, 0, 5);
      const gatePassed = gateTotal === 0 ? 0 : randInt(rng, 0, gateTotal);
      const gateResult: ChecklistResult = {
        items: Array.from({ length: gateTotal }, (_, j) => ({ id: `g-${j}`, text: `g${j}`, directive: null, evaluable: false, pass: j < gatePassed })),
        passed: gatePassed,
        total: gateTotal,
        complete: gateTotal > 0 && gatePassed === gateTotal,
      };
      if (!isComplete(state)) state = advanceGated(state, gateResult).state;

      // INVARIANT: every snapshot count is internally consistent.
      for (const snap of flowSnapshot(state)) {
        const p = snap.checklist_passed;
        const t = snap.checklist_total;
        // both null, or both numbers with 0 <= passed <= total.
        expect((p === null) === (t === null), `seed ${seed} pair`).toBe(true);
        if (p !== null && t !== null) {
          expect(p, `seed ${seed} p>=0`).toBeGreaterThanOrEqual(0);
          expect(p, `seed ${seed} p<=t`).toBeLessThanOrEqual(t);
        }
      }
    }
  });

  it('property_tests_are_seeded_and_reproducible', () => {
    // The SAME seed produces the SAME config + the SAME state trajectory, every time.
    const trajectory = (seed: number) => {
      const rng = mulberry32(seed);
      const cfg = randomConfig(rng);
      let state = initFlowState(cfg);
      const snaps = [flowSnapshot(state)];
      let guard = 0;
      while (!isComplete(state) && guard++ < 100) {
        state = advance(state);
        snaps.push(flowSnapshot(state));
      }
      return { stageIds: cfg.stages.map((s) => s.id), snaps };
    };
    for (const seed of [BASE_SEED, BASE_SEED + 7, BASE_SEED + 99]) {
      expect(trajectory(seed)).toEqual(trajectory(seed)); // same seed → identical
    }
    // sanity that the generator actually varies: many seeds yield >1 distinct trajectory.
    const distinct = new Set(
      Array.from({ length: 40 }, (_, i) => JSON.stringify(trajectory(BASE_SEED + i))),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });
});
