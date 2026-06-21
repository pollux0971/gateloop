/**
 * STORY-UST.1 — the skill-body wire: executor ↔ introspection isomorphism.
 *
 * Proves the foundation fix end-to-end across packages:
 *  - a registered skill's SKILL.md BODY reaches the composed prompt (not just a bullet);
 *  - the introspection view (harness-core mountedSkillsForRole + getAgentPromptView)
 *    composes BYTE-IDENTICALLY to the executor path (agent-core composeSystemPrompt fed
 *    by skill-runtime loadMountedSkillsForRole) — the ADR-024 §3.2 isomorphism invariant.
 *
 * Offline/scripted, no model, no network (real_api_calls untouched).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeSystemPrompt, type MountedSkill } from '@gateloop/agent-core';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';
import { mountedSkillsForRole, getAgentPromptView } from '@gateloop/harness-core';

function scaffold(root: string, rel: string, manifest: object, md: string) {
  const d = path.join(root, rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'skill.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(d, 'SKILL.md'), md);
}

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ust1-iso-'));
  scaffold(root, 'skills/developer/ponytail-lazy',
    { skill_id: 'developer.ponytail-lazy', agent_role: 'developer', description: 'lazy senior dev ladder', tests: ['t'], depends_on: [] },
    '# Ponytail\nThe ladder:\n1. YAGNI\n6. minimum code that works');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'skill_manifest.json'), JSON.stringify({
    skills: [
      { skill_id: 'developer.ponytail-lazy', agent_role: 'developer', path: 'skills/developer/ponytail-lazy', status: 'registered' },
    ],
  }, null, 2));
  return root;
}

const BASE = 'You are the Developer.';
const DOCS = '### Envelope: DeveloperTaskPacket';

describe('STORY-UST.1 executor↔introspection isomorphism', () => {
  it('skill body reaches the composed prompt (not a one-line bullet)', () => {
    const root = fixtureRoot();
    try {
      const executorSkills: MountedSkill[] = loadMountedSkillsForRole('developer', root)
        .map(s => ({ name: s.name, summary: s.summary, body: s.body, avoid: s.avoid }));
      const composed = composeSystemPrompt(BASE, executorSkills, DOCS);
      expect(composed).toContain('## Skill procedures');
      expect(composed).toContain('1. YAGNI');
      expect(composed).toContain('6. minimum code that works');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('introspection composes byte-identically to the executor (isomorphism preserved)', () => {
    const root = fixtureRoot();
    try {
      // Executor path
      const executorSkills: MountedSkill[] = loadMountedSkillsForRole('developer', root)
        .map(s => ({ name: s.name, summary: s.summary, body: s.body, avoid: s.avoid }));
      const executorPrompt = composeSystemPrompt(BASE, executorSkills, DOCS);

      // Introspection path: harness-core's loader → the SHARED composeSystemPrompt (injected)
      const introspectionSkills = mountedSkillsForRole('developer', root);
      const view = getAgentPromptView('developer',
        { base: BASE, mounted_skills: introspectionSkills, envelope_docs: DOCS },
        { compose: composeSystemPrompt });

      expect(view.composed).toBe(executorPrompt); // BYTE-IDENTICAL — the isomorphism invariant
      expect(view.composed).toContain('1. YAGNI'); // and the body is genuinely present in both
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
