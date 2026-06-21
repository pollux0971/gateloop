import { describe, it, expect } from 'vitest';
import { composeSystemPrompt, type MountedSkill } from './composeSystemPrompt.ts';
import * as agentCore from './index.ts';

const BASE = 'You are the Developer. Produce a minimal, additive, reversible patch.';
const SKILLS: MountedSkill[] = [
  { name: 'crud-web-app-template', summary: 'scaffold a CRUD app' },
  { name: 'rest-api-template' },
];
const DOCS = '### Envelope: DeveloperTaskPacket\nFields:\n- `story_id` (string, required): the story.';

describe('STORY-032.3 composeSystemPrompt', () => {
  it('composition_is_a_single_shared_pure_function / same_inputs_same_output', () => {
    const a = composeSystemPrompt(BASE, SKILLS, DOCS);
    const b = composeSystemPrompt(BASE, SKILLS, DOCS);
    expect(a).toBe(b); // deterministic — no I/O, no clock, no randomness
    // composes all three layers
    expect(a).toContain(BASE);
    expect(a).toContain('## Mounted skills');
    expect(a).toContain('crud-web-app-template: scaffold a CRUD app');
    expect(a).toContain('- rest-api-template');
    expect(a).toContain('## Envelopes you receive');
    expect(a).toContain('DeveloperTaskPacket');
  });

  it('handles empty skills / empty docs deterministically', () => {
    const onlyBase = composeSystemPrompt(BASE, [], '');
    expect(onlyBase).toBe(BASE);
    expect(onlyBase).not.toContain('## Mounted skills');
    expect(onlyBase).not.toContain('## Envelopes you receive');
  });

  it('introspection_will_use_it: the function is exported from agent-core for the endpoint', () => {
    expect(typeof agentCore.composeSystemPrompt).toBe('function');
    // it is THE shared function (same reference), not a copy
    expect(agentCore.composeSystemPrompt).toBe(composeSystemPrompt);
  });
});

describe('STORY-UST.1 composeSystemPrompt injects skill bodies (the wire)', () => {
  const WITH_BODY: MountedSkill[] = [
    {
      name: 'ponytail-lazy',
      summary: 'lazy senior dev',
      body: '## The ladder\n1. YAGNI\n2. stdlib first\n6. minimum code that works',
      avoid: ['over-build a cache nobody profiled'],
    },
  ];

  it('compose_system_prompt_injects_skill_body_not_one_line_bullet', () => {
    const out = composeSystemPrompt(BASE, WITH_BODY, '');
    // the bullet index is still present (unchanged behaviour)…
    expect(out).toContain('## Mounted skills');
    expect(out).toContain('- ponytail-lazy: lazy senior dev');
    // …AND the actual procedure body now reaches the prompt (the fix)
    expect(out).toContain('## Skill procedures');
    expect(out).toContain('### ponytail-lazy');
    expect(out).toContain('1. YAGNI');
    expect(out).toContain('6. minimum code that works');
    expect(out).toContain('AVOID: over-build a cache nobody profiled');
  });

  it('mounted_skill_carries_body_and_avoid_not_just_name_summary', () => {
    // a body-less skill is a bullet only; a body-carrying one adds the procedures section
    const bulletOnly = composeSystemPrompt(BASE, [{ name: 'x', summary: 'y' }], '');
    expect(bulletOnly).toContain('## Mounted skills');
    expect(bulletOnly).not.toContain('## Skill procedures');
  });

  it('body_injection_dependency_ordered_and_token_budgeted', () => {
    const pad = 'x'.repeat(400); // each body ≈ 100 tokens (chars/4)
    const skills: MountedSkill[] = [
      { name: 'a', body: `AAA ${pad}` },
      { name: 'b', body: `BBB ${pad}` },
      { name: 'c', body: `CCC ${pad}` },
    ];
    // budget admits ~1 body; the first (dependency-earliest) is always kept, in order
    const out = composeSystemPrompt(BASE, skills, '', { skillBodyTokenBudget: 110 });
    expect(out.indexOf('AAA')).toBeGreaterThan(-1);
    expect(out.indexOf('BBB')).toBe(-1);
    // truncation is stated, never silent
    expect(out).toContain('2 skill procedure(s) omitted for token budget');
    // order preserved: a appears before b/c would have
    expect(out.indexOf('### a')).toBeGreaterThan(-1);
  });

  it('deterministic with bodies: same inputs → same output', () => {
    expect(composeSystemPrompt(BASE, WITH_BODY, '')).toBe(composeSystemPrompt(BASE, WITH_BODY, ''));
  });
});
