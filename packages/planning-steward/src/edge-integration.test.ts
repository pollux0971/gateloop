/**
 * STORY-PTEST.4 — Negative / edge integration tests (offline).
 *
 * The failure + recovery paths unit tests skip: a malformed workflow config errors
 * (never silent), a missing/corrupt skill throws and surfaces, empty/partial docs block
 * with the right failing items, a blocked stage then a FIXED doc advances (recovery), and
 * reset returns to the initial state. Uses the REAL engine + the REAL bmad-prd skill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePlanningWorkflow,
  loadPlanningWorkflowFile,
  PlanningWorkflowConfigError,
  initFlowState,
  advance,
  advanceGated,
  flowSnapshot,
  activeIndex,
  type PlanningWorkflowConfig,
} from './workflow.js';
import { loadDocSkill, DocSkillLoadError } from './docskill.js';
import { evaluateChecklist } from './checklist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/planning-steward/src -> gateloop/skills/planning/bmad-prd
const PRD_SKILL_DIR = path.join(here, '..', '..', '..', 'skills', 'planning', 'bmad-prd');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ptest4-'));
  tmpDirs.push(d);
  return d;
}

const GOOD_PRD = `# PRD
## Overview
Problem. Primary users: operators. Scope — in scope: x; out of scope: y.
## Functional Requirements
FR-1: the system shall do X.
## Non-Functional Requirements
NFR-1: fast.
## Success criteria
- works
`;
const PARTIAL_PRD = '# PRD\n## Overview\nusers and scope, but nothing else.\n'; // no FR/NFR/Success sections

function cfg(stageIds: string[]): PlanningWorkflowConfig {
  return {
    mode: 'greenfield',
    label: 'GREENFIELD',
    stages: stageIds.map((id) => ({ id, name: id, desc: `d ${id}`, skill: id === 'brief' ? null : `bmad-${id}` })),
  };
}

describe('STORY-PTEST.4 — negative/edge integration', () => {
  it('malformed_workflow_yaml_errors_clearly_not_silent', () => {
    const cases: Array<[string, string]> = [
      ['empty config', ''],
      ['no stages list', 'mode: greenfield\nlabel: GREENFIELD\n'],
      ['unknown top-level key', 'mode: x\nlabel: y\nstages:\n  - id: a\n    name: A\n    desc: d\n    skill: ~\nbogus: 1\n'],
      ['stage missing id', 'mode: x\nlabel: y\nstages:\n  - name: A\n    desc: d\n    skill: ~\n'],
      ['empty stages list', 'mode: x\nlabel: y\nstages:\n'],
    ];
    for (const [label, text] of cases) {
      // it THROWS a typed error (never returns a partial/silent config).
      expect(() => parsePlanningWorkflow(text), label).toThrow(PlanningWorkflowConfigError);
    }
    // a missing config file also throws (not a silent default).
    expect(() => loadPlanningWorkflowFile(path.join(tmp(), 'does-not-exist.yaml'))).toThrow();
  });

  it('missing_or_corrupt_skill_file_throws_and_surfaces', () => {
    // a non-existent directory surfaces clearly.
    expect(() => loadDocSkill(path.join(tmp(), 'no-such-skill'))).toThrow(DocSkillLoadError);

    // a directory missing the required SKILL.md surfaces (corrupt/partial skill).
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'template.md'), '# t\n');
    fs.writeFileSync(path.join(dir, 'checklist.md'), '- [ ] x :: section: X\n');
    fs.mkdirSync(path.join(dir, 'steps'));
    let threw: unknown = null;
    try {
      loadDocSkill(dir);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(DocSkillLoadError);
    expect(String((threw as Error).message)).toMatch(/SKILL\.md/i); // the message surfaces WHAT is missing
  });

  it('empty_or_partial_doc_blocks_with_correct_failing_items', () => {
    const skill = loadDocSkill(PRD_SKILL_DIR);

    // empty doc → blocked; every CONTENT item fails (only the vacuous no-tbd may pass
    // since an empty string has no placeholder), so it is far from complete.
    const empty = evaluateChecklist(skill.checklist, '');
    expect(empty.total).toBeGreaterThan(0);
    expect(empty.complete).toBe(false);
    expect(empty.passed).toBeLessThan(empty.total);
    // the section/contains items (Overview, FR, NFR, users, scope…) all fail on empty.
    const emptyFailing = empty.items.filter((it) => !it.pass).map((it) => it.text).join(' | ');
    expect(emptyFailing).toMatch(/Overview/i);
    expect(emptyFailing).toMatch(/Functional Requirements/i);

    // partial doc (Overview only) → the FR/NFR/Success items specifically fail.
    const partial = evaluateChecklist(skill.checklist, PARTIAL_PRD);
    expect(partial.complete).toBe(false);
    const failingText = partial.items.filter((it) => !it.pass).map((it) => it.text).join(' | ');
    expect(failingText).toMatch(/Functional Requirements/i);
    // a good doc passes every item (sanity that the checklist is satisfiable).
    expect(evaluateChecklist(skill.checklist, GOOD_PRD).complete).toBe(true);
  });

  it('blocked_then_fixed_doc_advances_recovery_path', () => {
    const skill = loadDocSkill(PRD_SKILL_DIR);
    // single skill stage so it is the active stage after init.
    let state = initFlowState(cfg(['prd']));
    const activeBefore = activeIndex(state);

    // 1) submit a partial doc → blocked, state/ordering unchanged.
    const bad = advanceGated(state, evaluateChecklist(skill.checklist, PARTIAL_PRD));
    expect(bad.advanced).toBe(false);
    expect(bad.failingItems.length).toBeGreaterThan(0);
    expect(activeIndex(bad.state)).toBe(activeBefore); // still active, did not advance
    expect(flowSnapshot(bad.state)[0].status).toBe('active');

    // 2) recovery: submit the FIXED doc → advances (the same stage now completes).
    const good = advanceGated(bad.state, evaluateChecklist(skill.checklist, GOOD_PRD));
    expect(good.advanced).toBe(true);
    expect(flowSnapshot(good.state)[0].status).toBe('done');
    // the checklist record persisted across the block→fix (snapshot shows full pass).
    const snap = flowSnapshot(good.state)[0];
    expect(snap.checklist_passed).toBe(snap.checklist_total);
  });

  it('reset_returns_to_initial_state', () => {
    const config = cfg(['brief', 'prd', 'architecture']);
    const initial = initFlowState(config);
    const initialSnap = flowSnapshot(initial);

    // advance the flow, then "reset" by re-initialising the same config.
    let moved = advance(initial); // brief → prd active
    moved = advance(moved); // prd → architecture active
    expect(flowSnapshot(moved)).not.toEqual(initialSnap); // genuinely moved

    const reset = initFlowState(config);
    expect(flowSnapshot(reset)).toEqual(initialSnap); // back to the exact initial state
    expect(flowSnapshot(reset)[0].status).toBe('active');
    expect(flowSnapshot(reset).slice(1).every((s) => s.status === 'todo')).toBe(true);
  });
});
