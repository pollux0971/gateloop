import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocSkill, evaluateChecklist, parseChecklist } from '@gateloop/planning-steward';

const here = path.dirname(fileURLToPath(import.meta.url));
// gateloop/tests -> gateloop/skills/planning/bmad-prd
const SKILL_DIR = path.join(here, '..', 'skills', 'planning', 'bmad-prd');

const GOOD_PRD = `# PRD: Widget

## Overview
Solves slow widget assembly. Primary users: factory operators. Scope — in scope: assembly; out of scope: shipping.

## Functional Requirements
FR-1: the system shall assemble a widget Given parts When triggered Then it outputs a widget.
FR-2: the system shall report assembly failures.

## Non-Functional Requirements
NFR-1: p95 assembly latency < 200ms.

## Success criteria
- 99% of widgets assembled without manual intervention
`;

describe('STORY-PBMAD.1 — bmad-prd skill', () => {
  it('bmad_prd_skill_present_with_skillmd_steps_template_checklist', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.frontmatter.name).toBe('bmad-prd');
    expect(skill.frontmatter.role).toBe('PM');
    expect(skill.steps.length).toBeGreaterThanOrEqual(2); // 01 gather, 02 write FR/NFR
    expect(skill.steps.map((s) => s.filename)).toEqual([...skill.steps.map((s) => s.filename)].sort());
    expect(skill.template.length).toBeGreaterThan(0);
    expect(skill.checklist.length).toBeGreaterThan(0);
  });

  it('bmad_prd_loads_via_pskill_runtime', () => {
    // loads through the PSKILL runtime loader without throwing (ADR-0013: ungated)
    expect(() => loadDocSkill(SKILL_DIR)).not.toThrow();
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.frontmatter.extra.stage).toBe('prd'); // declared stage drives the prd workflow stage
  });

  it('prd_template_has_functional_and_nonfunctional_sections', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.template).toMatch(/##\s+Functional Requirements/);
    expect(skill.template).toMatch(/##\s+Non-Functional Requirements/);
  });

  it('prd_checklist_requires_testable_fr_and_no_tbd', () => {
    const skill = loadDocSkill(SKILL_DIR);
    const items = parseChecklist(skill.checklist);
    // checklist explicitly carries a no-tbd directive and an FR-itemization directive
    expect(items.some((i) => i.directive?.type === 'no-tbd')).toBe(true);
    expect(items.some((i) => i.directive?.type === 'contains' && i.directive.arg === 'FR-')).toBe(true);

    // and it actually evaluates under the completion checker:
    const good = evaluateChecklist(skill.checklist, GOOD_PRD);
    expect(good.complete).toBe(true); // a well-formed PRD passes every item

    // a PRD with a TBD fails the no-tbd item
    const withTbd = evaluateChecklist(skill.checklist, GOOD_PRD + '\nNFR-2: TBD\n');
    expect(withTbd.complete).toBe(false);
    expect(withTbd.items.find((i) => i.directive?.type === 'no-tbd')!.pass).toBe(false);

    // a PRD with no FR markers fails the testable-FR item
    const noFr = evaluateChecklist(skill.checklist, '# PRD\n## Overview\nusers and scope here.\n## Functional Requirements\nnone yet\n## Non-Functional Requirements\nx\n## Success criteria\ny\n');
    expect(noFr.items.find((i) => i.directive?.type === 'contains' && i.directive.arg === 'FR-')!.pass).toBe(false);
  });
});
