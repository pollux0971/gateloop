/**
 * @gateloop/planning-steward — Completion BARRIER (prove set≠effective)
 * STORY-PSKILL.5 (EPIC-PSKILL).
 *
 * Inherits the prove-*.ts discipline: PSKILL.4's done-gating and PSKILL.1's
 * error-surfacing are configuration; this proves them as tested invariants —
 * actively attempting the forbidden states and verifying they are refused /
 * surfaced. All three holding === the precondition for EPIC-PBMAD / EPIC-PWIRE.
 * Pure logic over injected probes: zero provider spend, no network (ADR-0013:
 * flow/quality logic, never an access gate). Load-error probes are supplied as
 * thunks so this composite stays free of filesystem code (the caller owns I/O).
 */
import { evaluateChecklist, type ChecklistResult } from './checklist.js';
import {
  initFlowState,
  advanceGated,
  flowSnapshot,
  activeIndex,
  PlanningWorkflowStateError,
  type PlanningWorkflowConfig,
} from './workflow.js';

/** Inputs to the completion barrier. */
export interface CompletionBarrierProbes {
  config: PlanningWorkflowConfig;
  checklistMd: string;
  passingDoc: string; // a doc for which every checklist item passes
  failingDocs: string[]; // docs that each break ≥1 checklist item
  /** Load attempts that MUST throw (e.g. () => loadDocSkill(brokenDir)). */
  loadAttemptsThatMustThrow: Array<() => unknown>;
}

/** Structured result of the completion barrier (each invariant + composite). */
export interface CompletionProof {
  failingItemBlocksDone: boolean;
  loadErrorsSurface: boolean;
  snapshotCountsMatch: boolean;
  allHeld: boolean;
}

/**
 * The EPIC-PSKILL barrier. Proves: (1) a stage with even one failing checklist
 * item truly cannot be marked done (advance actually refused, status intact);
 * (2) every supplied load attempt truly throws (errors surface, never silently
 * swallowed); (3) the snapshot's checklist_passed/total match the actual
 * evaluations. Returns the proof; THROWS PlanningWorkflowStateError if any
 * invariant fails.
 * @throws PlanningWorkflowStateError
 */
export function assertCompletionBarrier(p: CompletionBarrierProbes): CompletionProof {
  const s0 = initFlowState(p.config);
  const active = activeIndex(s0); // the stage under test (0)

  // ── invariant 1: one failing item truly blocks done ───────────────────────
  let failingItemBlocksDone = true;
  const passRes = evaluateChecklist(p.checklistMd, p.passingDoc);
  // TEETH: the all-pass doc MUST advance — the gate is not vacuously always-blocking
  if (!passRes.complete || !advanceGated(s0, passRes).advanced) failingItemBlocksDone = false;

  if (passRes.complete) {
    // synthetic: flip exactly ONE item to failing, one at a time → must block
    for (let k = 0; k < passRes.items.length; k++) {
      const items = passRes.items.map((it, i) => (i === k ? { ...it, pass: false } : it));
      const oneFail: ChecklistResult = {
        items,
        passed: items.filter((i) => i.pass).length,
        total: items.length,
        complete: false,
      };
      const g = advanceGated(s0, oneFail);
      if (g.advanced) failingItemBlocksDone = false;
      if (flowSnapshot(g.state)[active].status !== 'active') failingItemBlocksDone = false; // status intact
    }
  }
  // real failing docs → each must block, status intact
  for (const doc of p.failingDocs) {
    const res = evaluateChecklist(p.checklistMd, doc);
    if (res.complete) failingItemBlocksDone = false; // a "failing" doc that actually passes = bad probe
    const g = advanceGated(s0, res);
    if (g.advanced) failingItemBlocksDone = false;
    if (flowSnapshot(g.state)[active].status !== 'active') failingItemBlocksDone = false;
  }

  // ── invariant 3: snapshot counts match the actual evaluations ──────────────
  let snapshotCountsMatch = true;
  for (const doc of [p.passingDoc, ...p.failingDocs]) {
    const res = evaluateChecklist(p.checklistMd, doc);
    const g = advanceGated(s0, res);
    const snap = flowSnapshot(g.state)[active]; // the stage under test carries the recorded counts
    if (snap.checklist_passed !== res.passed || snap.checklist_total !== res.total) snapshotCountsMatch = false;
  }

  // ── invariant 2: load errors truly surface (never silently swallowed) ──────
  let loadErrorsSurface = true;
  for (const attempt of p.loadAttemptsThatMustThrow) {
    let threw = false;
    try {
      attempt();
    } catch {
      threw = true;
    }
    if (!threw) loadErrorsSurface = false;
  }

  const allHeld = failingItemBlocksDone && loadErrorsSurface && snapshotCountsMatch;
  if (!allHeld) {
    throw new PlanningWorkflowStateError(
      `completion barrier FAILED: failingItemBlocksDone=${failingItemBlocksDone}, ` +
        `loadErrorsSurface=${loadErrorsSurface}, snapshotCountsMatch=${snapshotCountsMatch}`,
    );
  }
  return { failingItemBlocksDone, loadErrorsSurface, snapshotCountsMatch, allHeld };
}
