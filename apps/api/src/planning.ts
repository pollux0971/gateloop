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
  authorAndAdvance,
  selectStageDocAuthor,
  type PlanningFlowState,
  type FlowStageSnapshot,
  type ChecklistItem,
  type RealAuthorDeps,
} from '@gateloop/planning-steward';

export interface PlanningFlowCtx {
  /** gateloop/ root — used to find configs/planning_workflow.yaml and skills/. */
  repo: string;
  /**
   * Optional real-author wiring (STORY-PLLM.4/.5/.6). When a request asks for
   * mode:'real', the loop uses this; the key is resolved INSIDE realAuthorDeps.buildEngine
   * (the secret seam) and never reaches the response. Absent → scripted only (the default,
   * CI-safe). This is the single server-side place the real provider is plugged in.
   */
  realAuthorDeps?: RealAuthorDeps;
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

/** POST /api/planning/author request body. */
export interface PlanningAuthorRequest {
  /** Operator idea / brief (drives the author prompt). */
  idea?: string;
  /** 'scripted' (default, offline, CI) | 'real' (opt-in, needs realAuthorDeps + the gate). */
  mode?: 'scripted' | 'real';
  /** Max re-authoring attempts after the first (default 2). */
  maxRewrites?: number;
}

/** POST /api/planning/author response. NEVER carries a key — the provider call (real
 *  mode) happens server-side inside the author seam; only the produced doc + flow leave. */
export interface PlanningAuthorResponse {
  ok: boolean;
  stageId: string | null;
  attempts: number;
  doc: string;
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
  author(body: PlanningAuthorRequest): Promise<PlanningAuthorResponse>;
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

  // Documents authored by completed stages — fed as priorDocs into later stages so
  // the pipeline (prd → architecture → epics) carries context forward. In-memory only.
  const authoredDocs: Record<string, string> = {};
  let lastIdea = '';

  const snapshot = (): PlanningFlowResponse => ({
    source: 'live',
    mode: state.mode,
    label: state.label,
    activeIndex: activeIndex(state),
    stages: flowSnapshot(state),
  });

  const service: PlanningFlowService = {
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

    /**
     * Server-side author→advance loop for the ACTIVE stage. Authors a doc via the seam
     * (scripted by default; real is opt-in and resolved entirely server-side), submits it
     * to the same checklist-gated advance, and on a block feeds failing_items back and
     * re-authors up to maxRewrites. The key (real mode) never leaves buildEngine; the
     * response carries only the produced doc + flow. Record-only (no policy write, no
     * access gate — the only condition is the quality checklist).
     */
    async author(body: PlanningAuthorRequest): Promise<PlanningAuthorResponse> {
      if (typeof body.idea === 'string' && body.idea.trim() !== '') lastIdea = body.idea.trim();

      const ai = activeIndex(state);
      if (ai === -1 || isComplete(state)) {
        return {
          ok: false, stageId: null, attempts: 0, doc: '', advanced: false,
          from: null, to: null, blocked_reason: 'flow already complete', failing_items: [],
          flow: snapshot(),
        };
      }
      const stage = state.stages[ai];

      // brief: operator idea-intake — no doc-skill, no authoring. The idea IS the doc;
      // advance is ungated. Record it as the brief document for downstream priorDocs.
      if (stage.skill === null) {
        const next = ai + 1 < state.stages.length ? state.stages[ai + 1].id : null;
        state = advanceFlow(state);
        authoredDocs[stage.id] = lastIdea;
        return {
          ok: true, stageId: stage.id, attempts: 1, doc: lastIdea, advanced: true,
          from: stage.id, to: next, blocked_reason: null, failing_items: [], flow: snapshot(),
        };
      }

      // skill-bearing stage: author via the seam, then run the gated loop.
      const skill = loadDocSkill(path.join(skillsRoot, 'planning', stage.skill));
      const author = selectStageDocAuthor(
        { mode: body.mode ?? 'scripted' },
        { real: ctx.realAuthorDeps },
      );

      // priorDocs = docs from EARLIER stages only (everything authored so far).
      const priorDocs: Record<string, string> = { ...authoredDocs };

      const result = await authorAndAdvance({
        author,
        skill: { steps: skill.steps, template: skill.template },
        context: { stageId: stage.id, idea: lastIdea, priorDocs },
        maxRewrites: body.maxRewrites,
        // The loop's advance maps straight onto the existing checklist-gated advance.
        advance: (doc) => {
          const r = service.advance({ doc });
          return { advanced: r.advanced, blocked_reason: r.blocked_reason, failing_items: r.failing_items };
        },
      });

      // On convergence, record the authored doc and compute the new active stage.
      let to: string | null = null;
      if (result.advanced) {
        authoredDocs[stage.id] = result.doc;
        const newAi = activeIndex(state);
        to = newAi === -1 ? null : state.stages[newAi].id;
      }

      return {
        ok: result.ok,
        stageId: stage.id,
        attempts: result.attempts,
        doc: result.doc,
        advanced: result.advanced,
        from: stage.id,
        to,
        blocked_reason: result.blocked_reason,
        failing_items: result.failing_items,
        flow: snapshot(),
      };
    },

    reset(): void {
      state = initFlowState(config);
      for (const k of Object.keys(authoredDocs)) delete authoredDocs[k];
      lastIdea = '';
    },
  };

  return service;
}
