import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocSkill, evaluateChecklist, parseChecklist } from '@gateloop/planning-steward';

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(here, '..', 'skills', 'planning', 'bmad-architecture');

const GOOD_ARCH = `# Architecture: Widget

## Summary
A TypeScript monorepo with an assembly engine and a failure reporter.

## Modules
- AssemblyEngine — assembles widgets (covers FR-1, FR-2)
- FailureReporter — surfaces failures (covers FR-2)

## Constraints
- TypeScript monorepo; no external network at runtime.

## Risks
- latency under load; mitigated by batching.
`;

describe('STORY-PBMAD.2 — bmad-architecture skill', () => {
  it('bmad_architecture_skill_present_with_skillmd_steps_template_checklist', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.frontmatter.name).toBe('bmad-architecture');
    expect(skill.frontmatter.role).toBe('Architect');
    expect(skill.steps.length).toBeGreaterThanOrEqual(2);
    expect(skill.template.length).toBeGreaterThan(0);
    expect(skill.checklist.length).toBeGreaterThan(0);
  });

  it('bmad_architecture_loads_via_pskill_runtime', () => {
    expect(() => loadDocSkill(SKILL_DIR)).not.toThrow();
    expect(loadDocSkill(SKILL_DIR).frontmatter.extra.inputs).toContain('prd'); // input is the PRD
  });

  it('architecture_template_has_modules_constraints_risks', () => {
    const skill = loadDocSkill(SKILL_DIR);
    expect(skill.template).toMatch(/##\s+Modules/);
    expect(skill.template).toMatch(/##\s+Constraints/);
    expect(skill.template).toMatch(/##\s+Risks/);
  });

  it('architecture_checklist_requires_fr_to_module_coverage', () => {
    const skill = loadDocSkill(SKILL_DIR);
    const items = parseChecklist(skill.checklist);
    // checklist carries the FR-coverage requirement (FR- markers + "covers FR-")
    expect(items.some((i) => i.directive?.type === 'contains' && i.directive.arg === 'FR-')).toBe(true);
    expect(items.some((i) => i.directive?.type === 'matches' && /covers/.test(i.directive.arg))).toBe(true);

    // evaluates under the completion checker: a doc whose modules cover FRs passes
    const good = evaluateChecklist(skill.checklist, GOOD_ARCH);
    expect(good.complete).toBe(true);

    // an architecture with NO FR references fails the coverage item
    const noCoverage = evaluateChecklist(
      skill.checklist,
      '# Arch\n## Summary\ns\n## Modules\n- A — does things\n## Constraints\n- c\n## Risks\n- r\n',
    );
    expect(noCoverage.complete).toBe(false);
    expect(noCoverage.items.find((i) => i.directive?.type === 'contains' && i.directive.arg === 'FR-')!.pass).toBe(false);
  });
});
