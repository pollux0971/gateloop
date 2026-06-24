import { describe, it, expect } from 'vitest';
import { buildAuthorPrompt, type AuthorPromptInput } from './authorprompt.js';
import type { ChecklistItem } from './checklist.js';

// A minimal doc-skill stand-in (only steps + template are read by the builder).
const SKILL = {
  steps: [
    { filename: '01-frame.md', content: 'Frame the problem and list the functional requirements.' },
    { filename: '02-nfr.md', content: 'Add the non-functional requirements section.' },
  ],
  template: '# PRD\n\n## FR\n\n## NFR\n',
};

function item(text: string, pass: boolean): ChecklistItem {
  return { id: `i-${text}`, text, directive: null, evaluable: false, pass };
}

const BASE: AuthorPromptInput = {
  stageId: 'prd',
  idea: 'Build a tiny URL shortener.',
  skill: SKILL,
};

describe('STORY-PLLM.2 author-prompt builder', () => {
  it('prompt_built_from_skill_steps_and_template', () => {
    const { system, prompt } = buildAuthorPrompt(BASE);
    // system names the stage and forbids fences/preamble (drives raw-doc output).
    expect(system).toContain('"prd"');
    expect(system.toLowerCase()).toContain('markdown');
    expect(system.toLowerCase()).toContain('no code fences');
    // both step contents appear, NUMBERED and in skill order.
    expect(prompt).toContain('## Authoring steps');
    expect(prompt).toContain('1. Frame the problem and list the functional requirements.');
    expect(prompt).toContain('2. Add the non-functional requirements section.');
    expect(prompt.indexOf('1. Frame')).toBeLessThan(prompt.indexOf('2. Add the non-functional'));
    // the template is included verbatim.
    expect(prompt).toContain('## Template to fill');
    expect(prompt).toContain('# PRD\n\n## FR\n\n## NFR');
  });

  it('context_idea_and_prior_docs_included_in_prompt', () => {
    const withPrior = buildAuthorPrompt({
      ...BASE,
      stageId: 'architecture',
      priorDocs: { prd: 'The approved PRD body with FR1 and FR2.' },
    });
    expect(withPrior.prompt).toContain('## Idea');
    expect(withPrior.prompt).toContain('Build a tiny URL shortener.');
    expect(withPrior.prompt).toContain('## Prior documents');
    expect(withPrior.prompt).toContain('### prd');
    expect(withPrior.prompt).toContain('The approved PRD body with FR1 and FR2.');

    // First stage (no prior docs) omits the Prior-documents section entirely.
    const firstStage = buildAuthorPrompt(BASE);
    expect(firstStage.prompt).not.toContain('## Prior documents');
    // An all-empty priorDocs map also omits the section (no blank heading).
    const emptyPrior = buildAuthorPrompt({ ...BASE, priorDocs: { brief: '   ' } });
    expect(emptyPrior.prompt).not.toContain('## Prior documents');

    // Prior docs render in INSERTION (pipeline) order, not alphabetical.
    const twoPrior = buildAuthorPrompt({
      ...BASE,
      stageId: 'epics',
      priorDocs: { prd: 'PRD-TEXT', architecture: 'ARCH-TEXT' },
    });
    expect(twoPrior.prompt.indexOf('### prd')).toBeLessThan(twoPrior.prompt.indexOf('### architecture'));
  });

  it('failing_items_when_present_included_as_fix_instructions', () => {
    const failing = [
      item('PRD must contain an ## FR section', false),
      item('No TBD placeholders allowed', false),
      item('This one already passed', true), // passed items are NOT fed back
    ];
    const reauthor = buildAuthorPrompt({ ...BASE, failingItems: failing });
    expect(reauthor.prompt).toContain('## Fix these issues');
    expect(reauthor.prompt).toContain('- PRD must contain an ## FR section');
    expect(reauthor.prompt).toContain('- No TBD placeholders allowed');
    // a passed item must not appear in the fix block.
    expect(reauthor.prompt).not.toContain('This one already passed');

    // No failing items (first attempt) → no Fix section.
    const firstAttempt = buildAuthorPrompt(BASE);
    expect(firstAttempt.prompt).not.toContain('## Fix these issues');
    // failingItems present but all already passed → still no Fix section.
    const allPass = buildAuthorPrompt({ ...BASE, failingItems: [item('done', true)] });
    expect(allPass.prompt).not.toContain('## Fix these issues');
  });

  it('prompt_builder_is_pure_and_deterministic_no_provider_call', () => {
    // Same input → byte-identical output across repeated calls.
    const a = buildAuthorPrompt(BASE);
    const b = buildAuthorPrompt(BASE);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // A re-author with the same failing items is also stable.
    const inp: AuthorPromptInput = {
      ...BASE,
      priorDocs: { prd: 'X' },
      failingItems: [item('fix me', false)],
    };
    expect(buildAuthorPrompt(inp)).toEqual(buildAuthorPrompt(inp));

    // The builder returns only {system, prompt} strings — no side effects, no
    // network/provider handle could be involved (it has no async surface).
    expect(Object.keys(a).sort()).toEqual(['prompt', 'system']);
    expect(typeof a.system).toBe('string');
    expect(typeof a.prompt).toBe('string');
  });
});
