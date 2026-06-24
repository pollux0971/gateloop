/**
 * apps/api — Planning flow endpoints (STORY-PWIRE.1 GET, STORY-PWIRE.2 POST).
 *
 * Exposes the LIVE PFLOW engine + PSKILL completion checker over two endpoints
 * the v6 console node-flow consumes:
 *   GET  /api/planning/flow     → live flow snapshot
 *   POST /api/planning/advance  → checklist-gated advance (record-only)
 *
 * The service holds the engine state in memory (not a fixture JSON) and is built
 * as a factory so the handlers are callable IN-PROCESS — the PWIRE.5 DOM landing
 * test wires window.fetch straight to getFlow/advance with no network. Per
 * ADR-0013 this is flow/quality logic: advance's ONLY condition is the quality
 * checklist; it never writes policy.yaml and carries no access gate.
 */
import * as path from 'node:path';
import {
  loadPlanningWorkflowFile,
  loadDocSkill,
  evaluateChecklist,
  initFlowState,
  flowSnapshot,
  advance as advanceFlow,
  advanceGated,
  activeIndex,
  isComplete,
  type PlanningFlowState,
  type FlowStageSnapshot,
  type ChecklistItem,
} from '@gateloop/planning-steward';

export interface PlanningFlowCtx {
  /** gateloop/ root — used to find configs/planning_workflow.yaml and skills/. */
  repo: string;
}

/** GET /api/planning/flow response — matches the console node-flow contract. */
export interface PlanningFlowResponse {
  source: 'live';
  mode: string;
  label: string;
  activeIndex: number;
  stages: FlowStageSnapshot[];
}

/** POST /api/planning/advance response. */
export interface PlanningAdvanceResponse {
  advanced: boolean;
  from: string | null;
  to: string | null;
  blocked_reason: string | null;
  failing_items: ChecklistItem[];
  flow: PlanningFlowResponse;
}

export interface PlanningFlowService {
  getFlow(): PlanningFlowResponse;
  advance(body: { doc?: string }): PlanningAdvanceResponse;
  reset(): void;
}

/**
 * Build a live planning-flow service rooted at `ctx.repo`. Holds the engine state
 * in memory; the config + skill checklists are read from the real repo (live).
 */
export function createPlanningFlowService(ctx: PlanningFlowCtx): PlanningFlowService {
  const configPath = path.join(ctx.repo, 'configs', 'planning_workflow.yaml');
  const skillsRoot = path.join(ctx.repo, 'skills');
  const config = loadPlanningWorkflowFile(configPath);
  let state: PlanningFlowState = initFlowState(config);

  const snapshot = (): PlanningFlowResponse => ({
    source: 'live',
    mode: state.mode,
    label: state.label,
    activeIndex: activeIndex(state),
    stages: flowSnapshot(state),
  });

  return {
    getFlow: snapshot,

    advance(body: { doc?: string }): PlanningAdvanceResponse {
      const ai = activeIndex(state);
      if (ai === -1 || isComplete(state)) {
        return { advanced: false, from: null, to: null, blocked_reason: 'flow already complete', failing_items: [], flow: snapshot() };
      }
      const stage = state.stages[ai];

      // brief: operator idea-intake — no doc-skill, no checklist → advance ungated
      if (stage.skill === null) {
        const next = ai + 1 < state.stages.length ? state.stages[ai + 1].id : null;
        state = advanceFlow(state);
        return { advanced: true, from: stage.id, to: next, blocked_reason: null, failing_items: [], flow: snapshot() };
      }

      // skill-bearing stage: gate the advance on its checklist (live PSKILL checker)
      const skill = loadDocSkill(path.join(skillsRoot, 'planning', stage.skill));
      const checklist = evaluateChecklist(skill.checklist, body.doc ?? '');
      const gated = advanceGated(state, checklist);
      state = gated.state;
      if (gated.advanced) {
        return { advanced: true, from: gated.from, to: gated.to, blocked_reason: null, failing_items: [], flow: snapshot() };
      }
      return {
        advanced: false,
        from: gated.from,
        to: null,
        blocked_reason: `checklist ${checklist.passed}/${checklist.total} — not complete`,
        failing_items: gated.failingItems,
        flow: snapshot(),
      };
    },

    reset(): void {
      state = initFlowState(config);
    },
  };
}
