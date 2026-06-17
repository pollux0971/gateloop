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
