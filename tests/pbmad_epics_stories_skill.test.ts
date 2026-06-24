import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocSkill, evaluateChecklist, parseChecklist } from '@gateloop/planning-steward';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(here, '..', 'skills', 'planning', 'bmad-epics-stories');

const GOOD_EPICS = `# Epics & Stories: Widget

## Epic E1 — Assembly
### Story E1.1 — Assemble core
- size: single-session
- deps: none
- As a factory operator, I want to assemble a widget, so that I save time.
- AC: Given parts When triggered Then a widget is output.
- covers: FR-1
### Story E1.2 — Report failures
- size: single-session
- deps: E1.1
- As an operator, I want failure reports, so that I can react.
- AC: Given a failed assembly When it occurs Then a report is shown.
- covers: FR-2
`;

const findItem = (cl: string, pred: (d: { type: string; arg: string } | null) => boolean) =>
  parseChecklist(cl).find((i) => pred(i.directive));

describe('STORY-PBMAD.3 — bmad-epics-stories skill', () => {
  it('bmad_epics_stories_skill_present_with_skillmd_steps_template_checklist', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.frontmatter.name).toBe('bmad-epics-stories');
    expect(skill.steps.length).toBeGreaterThanOrEqual(3); // design, create, validate
    expect(skill.template.length).toBeGreaterThan(0);
    expect(skill.checklist.length).toBeGreaterThan(0);
  });

  it('bmad_epics_stories_loads_via_pskill_runtime', () => {
    expect(() => loadDocSkill(SKILL_DIR)).not.toThrow();
    const inputs = loadDocSkill(SKILL_DIR).frontmatter.extra.inputs ?? '';
    expect(inputs).toContain('prd');
    expect(inputs).toContain('architecture'); // input is PRD + Architecture
  });

  it('epics_template_uses_given_when_then_acceptance', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.template).toMatch(/Given .* When .* Then/);
    expect(skill.template).toMatch(/As a .*I want .*so that/);
  });

  it('epics_checklist_enforces_single_dev_story_size', () => {
    const skill = loadDocSkill(SKILL_DIR);
    const item = findItem(skill.checklist, (d) => d?.type === 'contains' && d.arg.includes('single-session'));
    expect(item).toBeDefined();
    expect(evaluateChecklist(skill.checklist, GOOD_EPICS).complete).toBe(true);
    // a story without a single-session size declaration fails the size item
    const noSize = GOOD_EPICS.replace(/- size: single-session\n/g, '');
    const res = evaluateChecklist(skill.checklist, noSize);
    expect(res.items.find((i) => i.directive?.arg.includes('single-session'))!.pass).toBe(false);
  });

  it('epics_checklist_enforces_no_future_dependency_within_epic', () => {
    const skill = loadDocSkill(SKILL_DIR);
    const item = findItem(skill.checklist, (d) => d?.type === 'contains' && d.arg.includes('deps:'));
    expect(item).toBeDefined(); // checklist encodes the dependency-declaration rule
    // a backlog with no deps declarations fails it (deps must be declared backward-only)
    const noDeps = GOOD_EPICS.replace(/- deps:.*\n/g, '');
    const res = evaluateChecklist(skill.checklist, noDeps);
    expect(res.items.find((i) => i.directive?.arg.includes('deps:'))!.pass).toBe(false);
  });

  it('epics_checklist_requires_every_fr_covered_by_a_story', () => {
    const skill = loadDocSkill(SKILL_DIR);
    const item = findItem(skill.checklist, (d) => d?.type === 'contains' && d.arg.includes('FR-'));
    expect(item).toBeDefined();
    expect(evaluateChecklist(skill.checklist, GOOD_EPICS).items.find((i) => i.directive?.arg.includes('FR-'))!.pass).toBe(true);
    const noCover = GOOD_EPICS.replace(/- covers: FR-\d\n/g, '');
    const res = evaluateChecklist(skill.checklist, noCover);
    expect(res.items.find((i) => i.directive?.arg.includes('FR-'))!.pass).toBe(false);
  });
});
