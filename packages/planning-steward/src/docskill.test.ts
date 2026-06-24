import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocSkill, parseSkillFrontmatter, DocSkillLoadError } from './docskill.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/planning-steward/src -> gateloop/skills/planning/_TEMPLATE
const REAL_TEMPLATE = path.join(here, '..', '..', '..', 'skills', 'planning', '_TEMPLATE');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

interface SkillFiles {
  skillMd?: string | null;
  template?: string | null;
  checklist?: string | null;
  steps?: Record<string, string> | null; // filename -> content; null = omit steps/ dir
  tests?: boolean; // add a tests/ dir (to prove registration is not test-gated)
}

const GOOD_SKILL_MD = `---
name: bmad-prd
description: Author the PRD
role: PM
stage: prd
---
# bmad-prd body
Author the PRD section by section.`;

function makeSkill(files: SkillFiles): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docskill-'));
  tmpDirs.push(dir);
  if (files.skillMd !== null) fs.writeFileSync(path.join(dir, 'SKILL.md'), files.skillMd ?? GOOD_SKILL_MD);
  if (files.template !== null) fs.writeFileSync(path.join(dir, 'template.md'), files.template ?? '# Template\n## Overview\n');
  if (files.checklist !== null) fs.writeFileSync(path.join(dir, 'checklist.md'), files.checklist ?? '- [ ] overview present\n');
  if (files.steps !== null) {
    const stepsDir = path.join(dir, 'steps');
    fs.mkdirSync(stepsDir);
    const steps = files.steps ?? { '01_a.md': 'step a', '02_b.md': 'step b' };
    for (const [fn, content] of Object.entries(steps)) fs.writeFileSync(path.join(stepsDir, fn), content);
  }
  if (files.tests) fs.mkdirSync(path.join(dir, 'tests'));
  return dir;
}

describe('STORY-PSKILL.1 — doc-authoring skill loader', () => {
  it('skill_loads_frontmatter_steps_template_checklist_into_typed_object', () => {
    const dir = makeSkill({});
    const skill = loadDocSkill(dir);
    expect(skill.frontmatter.name).toBe('bmad-prd');
    expect(skill.frontmatter.description).toBe('Author the PRD');
    expect(skill.frontmatter.role).toBe('PM');
    expect(skill.frontmatter.extra.stage).toBe('prd'); // optional metadata preserved
    expect(skill.body).toContain('# bmad-prd body');
    expect(skill.steps.map((s) => s.filename)).toEqual(['01_a.md', '02_b.md']);
    expect(skill.steps[0].content).toBe('step a');
    expect(skill.template).toContain('## Overview');
    expect(skill.checklist).toContain('overview present');
    expect(skill.dir).toBe(dir);
  });

  it('steps_enumerated_in_filename_order', () => {
    // intentionally out-of-order on disk; loader sorts by filename
    const dir = makeSkill({ steps: { '10_last.md': 'L', '02_mid.md': 'M', '01_first.md': 'F' } });
    const skill = loadDocSkill(dir);
    expect(skill.steps.map((s) => s.filename)).toEqual(['01_first.md', '02_mid.md', '10_last.md']);
    expect(skill.steps.map((s) => s.content)).toEqual(['F', 'M', 'L']);
  });

  it('missing_required_file_throws_clear_error_not_silent', () => {
    expect(() => loadDocSkill(makeSkill({ skillMd: null }))).toThrow(/missing required file 'SKILL.md'/);
    expect(() => loadDocSkill(makeSkill({ template: null }))).toThrow(/missing required file 'template.md'/);
    expect(() => loadDocSkill(makeSkill({ checklist: null }))).toThrow(/missing required file 'checklist.md'/);
    expect(() => loadDocSkill(makeSkill({ steps: null }))).toThrow(/missing required directory 'steps\/'/);
    // a non-existent directory
    expect(() => loadDocSkill('/no/such/skill/dir')).toThrow(DocSkillLoadError);

    // malformed frontmatter: no '---' block
    expect(() => loadDocSkill(makeSkill({ skillMd: '# no frontmatter here' }))).toThrow(/must start with a '---'/);
    // unterminated frontmatter
    expect(() => loadDocSkill(makeSkill({ skillMd: '---\nname: x\n' }))).toThrow(/unterminated frontmatter/);
    // missing required frontmatter key (role)
    expect(() => loadDocSkill(makeSkill({ skillMd: '---\nname: x\ndescription: d\n---\nbody' }))).toThrow(
      /missing required frontmatter field 'role'/,
    );
    // every failure is the typed error, never a silent return
    let threw = false;
    try {
      loadDocSkill(makeSkill({ skillMd: 'garbage with no frontmatter' }));
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(DocSkillLoadError);
    }
    expect(threw).toBe(true);
  });

  it('skill_loader_does_not_gate_registration', () => {
    // ADR-0013 operator-trust: a skill with NO tests/ dir loads fine — the loader
    // never runs tests, never quarantines, never blocks registration.
    const noTests = makeSkill({ tests: false });
    expect(fs.existsSync(path.join(noTests, 'tests'))).toBe(false);
    expect(() => loadDocSkill(noTests)).not.toThrow();
    const skill = loadDocSkill(noTests);
    expect(skill.frontmatter.name).toBe('bmad-prd');

    // even a skill whose checklist is empty/"would fail" still LOADS (loading != gating)
    const weak = makeSkill({ checklist: '' });
    expect(() => loadDocSkill(weak)).not.toThrow();
    expect(loadDocSkill(weak).checklist).toBe('');

    // presence of a tests/ dir changes nothing about loading either
    const withTests = makeSkill({ tests: true });
    expect(() => loadDocSkill(withTests)).not.toThrow();
  });

  it('template_scaffold_present_for_new_skills', () => {
    // the shipped scaffold exists and is itself a loadable doc-skill
    expect(fs.existsSync(REAL_TEMPLATE)).toBe(true);
    const tpl = loadDocSkill(REAL_TEMPLATE);
    expect(tpl.frontmatter.name).toBeTruthy();
    expect(tpl.frontmatter.description).toBeTruthy();
    expect(tpl.frontmatter.role).toBeTruthy();
    expect(tpl.steps.length).toBeGreaterThanOrEqual(1);
    expect(tpl.steps.map((s) => s.filename)).toEqual([...tpl.steps.map((s) => s.filename)].sort());
    expect(tpl.template.length).toBeGreaterThan(0);
    expect(tpl.checklist.length).toBeGreaterThan(0);
  });

  it('parseSkillFrontmatter_handles_blank_lines_and_comments', () => {
    const { frontmatter, body } = parseSkillFrontmatter(
      '\n---\n# a comment\nname: s\ndescription: d\n\nrole: R\n---\nthe body\n',
      'unit',
    );
    expect(frontmatter.name).toBe('s');
    expect(frontmatter.role).toBe('R');
    expect(body).toBe('the body');
  });
});
