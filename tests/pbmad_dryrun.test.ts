import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runPlanningDryRun,
  checkStoryGranularity,
  loadPlanningWorkflowFile,
  createPlanningBundle,
  generateBacklogFromPlanningBundle,
  assertStoriesCarryFullContract,
  validateStoryContractComplete,
  type IdeaInput,
  type DryRunOptions,
} from '@gateloop/planning-steward';

const here = path.dirname(fileURLToPath(import.meta.url));
const GATELOOP = path.join(here, '..');
const CONFIG = loadPlanningWorkflowFile(path.join(GATELOOP, 'configs', 'planning_workflow.yaml'));
const SKILLS_ROOT = path.join(GATELOOP, 'skills');

const GOOD_PRD = `# PRD: Widget
## Overview
Solves slow assembly. Primary users: factory operators. Scope — in scope: assembly; out of scope: shipping.
## Functional Requirements
FR-1: the system shall assemble a widget Given parts When triggered Then a widget is output.
FR-2: the system shall report failures.
## Non-Functional Requirements
NFR-1: p95 latency < 200ms.
## Success criteria
- 99% assembled without intervention
`;
const GOOD_ARCH = `# Architecture: Widget
## Summary
TypeScript monorepo with an assembly engine.
## Modules
- AssemblyEngine — assembles (covers FR-1, FR-2)
## Constraints
- TypeScript monorepo.
## Risks
- latency; mitigated by batching.
`;
const GOOD_EPICS = `# Epics & Stories: Widget
## Epic E1 — Assembly
### Story E1.1 — Assemble core
- size: single-session
- deps: none
- As a operator, I want assembly, so that I save time.
- AC: Given parts When triggered Then a widget is output.
- covers: FR-1
### Story E1.2 — Report failures
- size: single-session
- deps: E1.1
- As a operator, I want reports, so that I can react.
- AC: Given a failure When it occurs Then a report shows.
- covers: FR-2
`;

const BUNDLE_INPUT: IdeaInput = {
  title: 'Widget Assembler',
  description: 'A system to assemble widgets for factory operators.',
  goals: ['assemble widgets quickly'],
  non_goals: ['shipping'],
  constraints: ['typescript monorepo'],
  target_users: ['factory operators'],
};

const opts = (docs: Record<string, string>): DryRunOptions => ({
  config: CONFIG,
  skillsRoot: SKILLS_ROOT,
  docs,
  bundleInput: BUNDLE_INPUT,
});
const PASSING_DOCS = { brief: 'assemble widgets', prd: GOOD_PRD, architecture: GOOD_ARCH, epics: GOOD_EPICS };

describe('STORY-PBMAD.4 — backend dry-run (brief→epics)', () => {
  it('full_flow_brief_to_epics_runs_through_engine_runtime_and_three_skills', () => {
    const res = runPlanningDryRun(opts(PASSING_DOCS));
    expect(res.complete).toBe(true); // every stage reached done
    expect(res.stages.map((s) => s.stage)).toEqual(['brief', 'prd', 'architecture', 'epics']);
    expect(res.stages.every((s) => s.advanced)).toBe(true);
    // the three doc-skills were actually loaded + checklist-evaluated (runtime engaged)
    expect(res.stages.filter((s) => s.skill !== null).map((s) => s.skill)).toEqual([
      'bmad-prd',
      'bmad-architecture',
      'bmad-epics-stories',
    ]);
    expect(res.stages.filter((s) => s.checklist !== null).every((s) => s.checklist!.complete)).toBe(true);
    expect(res.backlog).not.toBeNull();
  });

  it('each_stage_advances_only_when_its_checklist_passes', () => {
    // a PRD missing functional requirements fails the prd checklist → run halts there
    const badPrd = '# PRD\n## Overview\nusers and scope.\n## Non-Functional Requirements\nx\n## Success criteria\ny\n';
    const res = runPlanningDryRun(opts({ ...PASSING_DOCS, prd: badPrd }));
    expect(res.complete).toBe(false);
    const prd = res.stages.find((s) => s.stage === 'prd')!;
    expect(prd.advanced).toBe(false); // checklist failed -> not advanced
    expect(res.stages.some((s) => s.stage === 'architecture')).toBe(false); // halted before architecture
    expect(res.backlog).toBeNull(); // never reached epics

    // with passing docs, every stage advances
    const good = runPlanningDryRun(opts(PASSING_DOCS));
    expect(good.stages.every((s) => s.advanced)).toBe(true);
  });

  it('epics_stage_reuses_generate_backlog_from_planning_bundle_not_rewritten', () => {
    const res = runPlanningDryRun(opts(PASSING_DOCS));
    // the dry-run's backlog is byte-identical to calling the existing generator directly
    const direct = generateBacklogFromPlanningBundle(createPlanningBundle(BUNDLE_INPUT));
    expect(res.backlog).toEqual(direct); // reuse, not a reimplementation
  });

  it('produced_backlog_is_schema_valid', () => {
    const res = runPlanningDryRun(opts(PASSING_DOCS));
    const backlog = res.backlog!;
    expect(backlog.epics.length).toBeGreaterThan(0);
    expect(backlog.stories.length).toBeGreaterThan(0);
    // the full-contract gate accepts every story (schema-valid contracts)
    expect(() => assertStoriesCarryFullContract(backlog.stories)).not.toThrow();
    for (const s of backlog.stories) {
      expect(validateStoryContractComplete(s)).toEqual([]);
    }
  });

  it('produced_stories_respect_single_dev_and_no_future_dep_rules', () => {
    const res = runPlanningDryRun(opts(PASSING_DOCS));
    const g = checkStoryGranularity(res.backlog!);
    expect(g.singleDev).toBe(true); // every story single-dev-session sized
    expect(g.noFutureDep).toBe(true); // no story depends on a later story in the same epic
  });
});
