import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePlanningWorkflow, initFlowState, advanceGated, flowSnapshot } from './workflow.js';
import { evaluateChecklist } from './checklist.js';
import { loadDocSkill, DocSkillLoadError } from './docskill.js';
import { assertCompletionBarrier, type CompletionBarrierProbes } from './completionbarrier.js';

const CONFIG = parsePlanningWorkflow(`
mode: greenfield
label: GREENFIELD
stages:
  - id: prd
    name: PRD
    desc: d
    skill: bmad-prd
  - id: epics
    name: epics
    desc: d
    skill: bmad-epics-stories
`);
const CHECKLIST = '- [ ] overview :: section: Overview\n- [ ] no tbd :: no-tbd\n- [ ] has FR :: contains: FR-\n';
const PASS_DOC = '# PRD\n## Overview\nGood overview.\nFR-1: do a thing.\n';
const FAIL_TBD = '# PRD\n## Overview\nGood.\nFR-1: x\nstatus: TBD\n'; // fails no-tbd
const FAIL_NO_FR = '# PRD\n## Overview\nGood overview only.\n'; // fails contains FR-

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Make a doc-skill dir, optionally omitting one required file (to break it). */
function makeSkill(omit?: 'SKILL.md' | 'template.md' | 'checklist.md' | 'steps' | 'frontmatter'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbar-'));
  tmp.push(dir);
  const skillMd =
    omit === 'frontmatter' ? '# no frontmatter' : '---\nname: s\ndescription: d\nrole: R\n---\nbody';
  if (omit !== 'SKILL.md') fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd);
  if (omit !== 'template.md') fs.writeFileSync(path.join(dir, 'template.md'), '# t');
  if (omit !== 'checklist.md') fs.writeFileSync(path.join(dir, 'checklist.md'), '- [ ] x :: no-tbd');
  if (omit !== 'steps') {
    fs.mkdirSync(path.join(dir, 'steps'));
    fs.writeFileSync(path.join(dir, 'steps', '01.md'), 'step');
  }
  return dir;
}

const probes = (): CompletionBarrierProbes => ({
  config: CONFIG,
  checklistMd: CHECKLIST,
  passingDoc: PASS_DOC,
  failingDocs: [FAIL_TBD, FAIL_NO_FR],
  loadAttemptsThatMustThrow: [
    () => loadDocSkill(makeSkill('SKILL.md')),
    () => loadDocSkill(makeSkill('template.md')),
    () => loadDocSkill(makeSkill('checklist.md')),
    () => loadDocSkill(makeSkill('steps')),
    () => loadDocSkill(makeSkill('frontmatter')),
    () => loadDocSkill('/no/such/skill'),
  ],
});

describe('STORY-PSKILL.5 — completion barrier (prove set≠effective)', () => {
  it('one_failing_checklist_item_truly_blocks_done_invariant', () => {
    const s0 = initFlowState(CONFIG);
    // all pass -> advances (teeth: not vacuously blocking)
    expect(advanceGated(s0, evaluateChecklist(CHECKLIST, PASS_DOC)).advanced).toBe(true);
    // even ONE failing item -> truly refused, status intact
    for (const doc of [FAIL_TBD, FAIL_NO_FR]) {
      const res = evaluateChecklist(CHECKLIST, doc);
      expect(res.complete).toBe(false);
      expect(res.passed).toBe(res.total - 1); // exactly one item fails
      const g = advanceGated(s0, res);
      expect(g.advanced).toBe(false);
      expect(flowSnapshot(g.state)[0].status).toBe('active'); // not marked done
    }
  });

  it('missing_or_corrupt_skill_file_truly_throws_and_surfaces_invariant', () => {
    // each broken skill actually throws (errors surface, never silently swallowed)
    expect(() => loadDocSkill(makeSkill('SKILL.md'))).toThrow(DocSkillLoadError);
    expect(() => loadDocSkill(makeSkill('template.md'))).toThrow(/missing required file 'template.md'/);
    expect(() => loadDocSkill(makeSkill('checklist.md'))).toThrow(/missing required file 'checklist.md'/);
    expect(() => loadDocSkill(makeSkill('steps'))).toThrow(/missing required directory 'steps\/'/);
    expect(() => loadDocSkill(makeSkill('frontmatter'))).toThrow(DocSkillLoadError);
    // TEETH: a WELL-FORMED skill loads without throwing (errors aren't spuriously raised)
    expect(() => loadDocSkill(makeSkill())).not.toThrow();
  });

  it('snapshot_checklist_counts_match_actual_evaluations_invariant', () => {
    const s0 = initFlowState(CONFIG);
    for (const doc of [PASS_DOC, FAIL_TBD, FAIL_NO_FR]) {
      const res = evaluateChecklist(CHECKLIST, doc);
      const g = advanceGated(s0, res);
      const snap = flowSnapshot(g.state)[0];
      expect(snap.checklist_passed).toBe(res.passed); // snapshot matches actual evaluation
      expect(snap.checklist_total).toBe(res.total);
    }
  });

  it('composite_completion_barrier_all_held_precondition_for_pbmad_pwire', () => {
    const proof = assertCompletionBarrier(probes());
    expect(proof.failingItemBlocksDone).toBe(true);
    expect(proof.loadErrorsSurface).toBe(true);
    expect(proof.snapshotCountsMatch).toBe(true);
    expect(proof.allHeld).toBe(true); // === precondition for PBMAD/PWIRE
    expect(() => assertCompletionBarrier(probes())).not.toThrow();

    // TEETH: if a "load attempt" does NOT throw, the barrier catches it and FAILS
    const broken = probes();
    broken.loadAttemptsThatMustThrow = [() => 'I did not throw'];
    expect(() => assertCompletionBarrier(broken)).toThrow(/loadErrorsSurface=false/);

    // TEETH: if a "failing" doc actually passes, the barrier catches it and FAILS
    const broken2 = probes();
    broken2.failingDocs = [PASS_DOC]; // not actually failing
    expect(() => assertCompletionBarrier(broken2)).toThrow(/failingItemBlocksDone=false/);
  });

  it('proof_is_zero_cost_no_real_spend', () => {
    const result = assertCompletionBarrier(probes());
    expect(result).not.toBeInstanceOf(Promise); // synchronous, no async provider call
    // deterministic: identical probes -> identical proof
    expect(assertCompletionBarrier(probes())).toEqual(assertCompletionBarrier(probes()));
    // operates on in-memory config/checklist/docs + local temp files only — no provider
    // or network handle is involved, so it cannot incur real spend.
  });
});
