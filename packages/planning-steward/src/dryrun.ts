/**
 * @gateloop/planning-steward — Backend dry-run integration
 * STORY-PBMAD.4 (EPIC-PBMAD).
 *
 * Drives a fixture brief through the whole planning spine — the PFLOW engine
 * (stage ordering), the PSKILL runtime (doc-skill loading + completion checker),
 * and the three BMAD skills — advancing each stage ONLY when its checklist
 * passes, and producing a valid epics artifact at the end by REUSING the existing
 * generateBacklogFromPlanningBundle (borrow, don't rewrite). No UI, no LLM, no
 * network: deterministic backend proof the pipeline works before any wiring.
 * Flow/quality logic, no access gate (ADR-0013).
 */
import * as path from 'node:path';
import {
  initFlowState,
  advance,
  advanceGated,
  isComplete,
  type PlanningFlowState,
  type PlanningWorkflowConfig,
} from './workflow.js';
import { loadDocSkill } from './docskill.js';
import { evaluateChecklist, type ChecklistResult } from './checklist.js';
// generateBacklogFromPlanningBundle / createPlanningBundle live in index.ts; used
// only inside runPlanningDryRun (function body), so the import cycle is harmless.
import {
  createPlanningBundle,
  generateBacklogFromPlanningBundle,
  type IdeaInput,
  type GeneratedBacklog,
} from './index.js';

/** Per-stage outcome of a dry run. */
export interface DryRunStageResult {
  stage: string;
  skill: string | null;
  advanced: boolean;
  checklist: ChecklistResult | null; // null for the brief (no doc-skill)
}

/** Result of a full dry run. */
export interface DryRunResult {
  flow: PlanningFlowState; // final flow state
  complete: boolean; // every stage reached done
  stages: DryRunStageResult[]; // in stage order, up to where it halted
  backlog: GeneratedBacklog | null; // produced at the epics stage (null if it never got there)
}

/** Inputs to a dry run. */
export interface DryRunOptions {
  config: PlanningWorkflowConfig; // the 4-stage planning workflow
  skillsRoot: string; // directory that contains planning/<skill-name>/
  docs: Record<string, string>; // stage id → authored document draft (fixtures)
  bundleInput: IdeaInput; // for the reused backlog generator
}

/**
 * Run the full brief→epics flow. Each skill-bearing stage is checklist-gated: it
 * advances only when its checklist passes; the first failing stage halts the run
 * (its `advanced` is false and no later stage runs). The epics stage produces the
 * backlog via the existing generator. Deterministic, no LLM/network.
 */
export function runPlanningDryRun(opts: DryRunOptions): DryRunResult {
  let state = initFlowState(opts.config);
  const stages: DryRunStageResult[] = [];
  let backlog: GeneratedBacklog | null = null;

  for (const stage of opts.config.stages) {
    if (isComplete(state)) break;

    if (stage.skill === null) {
      // brief: operator idea-intake — no doc-skill, no checklist → advance ungated
      state = advance(state);
      stages.push({ stage: stage.id, skill: null, advanced: true, checklist: null });
      continue;
    }

    const skill = loadDocSkill(path.join(opts.skillsRoot, 'planning', stage.skill));
    const doc = opts.docs[stage.id] ?? '';
    const checklist = evaluateChecklist(skill.checklist, doc);
    const gated = advanceGated(state, checklist);
    state = gated.state;
    stages.push({ stage: stage.id, skill: stage.skill, advanced: gated.advanced, checklist });

    if (!gated.advanced) break; // checklist failed → stage stays active, run halts here

    if (stage.id === 'epics') {
      // reuse the existing backlog generator for the epics artifact (don't rewrite)
      const bundle = createPlanningBundle(opts.bundleInput);
      backlog = generateBacklogFromPlanningBundle(bundle);
    }
  }

  return { flow: state, complete: isComplete(state), stages, backlog };
}

/**
 * Check the generated backlog against the epics fine-grainedness rules:
 *  - singleDev: every story is single-dev-session sized (not large/xlarge);
 *  - noFutureDep: no story depends on a LATER story in the same epic.
 * Deterministic, structural — mirrors the bmad-epics-stories checklist intent.
 */
export function checkStoryGranularity(backlog: GeneratedBacklog): { singleDev: boolean; noFutureDep: boolean } {
  const SINGLE_DEV = new Set(['trivial', 'small', 'medium']);
  const singleDev = backlog.stories.every((s) => SINGLE_DEV.has(s.estimated_complexity));

  const order = new Map(backlog.stories.map((s, i) => [s.story_id, i]));
  const noFutureDep = backlog.stories.every((s, i) =>
    s.depends_on.every((dep) => {
      const depStory = backlog.stories.find((x) => x.story_id === dep);
      if (!depStory || depStory.epic_id !== s.epic_id) return true; // cross-epic dep is fine
      return (order.get(dep) ?? Number.POSITIVE_INFINITY) < i; // same-epic dep must come earlier
    }),
  );
  return { singleDev, noFutureDep };
}
