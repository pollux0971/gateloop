/**
 * STORY-UST.4 WORK 0 + WORK 1 — body truly in the live prompt + executor↔introspection
 * isomorphism, for BOTH the developer and the reviewer wire.
 *
 *  - WORK 1: the composed prompt CONTAINS the registered skill's SKILL.md body (the
 *    direct contrast to the old one-line bullet), dependency-ordered, AVOID included.
 *  - WORK 0: the reviewer callsite now mounts skills too (reviewer.ponytail-review
 *    reaches the live reviewer prompt), composed by the SAME composeSystemPrompt.
 *  - Isomorphism: for each role, the introspection view composes BYTE-IDENTICALLY to
 *    the executor prompt (same shared function, same body-carrying inputs).
 *
 * Offline/scripted; no model, no network (real_api_calls untouched).
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { composeSystemPrompt, envelopeDocsForRole, type MountedSkill } from '@gateloop/agent-core';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';
import { mountedSkillsForRole, getAgentPromptView } from '@gateloop/harness-core';
import { developerSystemPromptBase } from '@gateloop/developer-runtime';
import { reviewerSystemPromptBase, composeReviewerSystemPrompt } from '@gateloop/reviewer-runtime';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // tests/ → gateloop/

/** Map the skill-runtime loader output to agent-core MountedSkill (executor side). */
function executorSkills(role: 'developer' | 'reviewer'): MountedSkill[] {
  return loadMountedSkillsForRole(role, repoRoot).map(s => ({ name: s.name, summary: s.summary, body: s.body, avoid: s.avoid }));
}

describe('STORY-UST.4 WORK 1 — skill body truly in the live prompt (not a bullet)', () => {
  it('developer prompt contains the ponytail-lazy ladder body', () => {
    const composed = composeSystemPrompt(developerSystemPromptBase(), executorSkills('developer'), envelopeDocsForRole('developer'));
    expect(composed).toContain('## Skill procedures');       // the body section exists
    expect(composed).toContain('minimum code that works');   // an actual ladder line
    expect(composed).toContain('Never remove an existing exported'); // coordination edit in the body
    // direct contrast to the OLD behaviour: a name-only mount is just a bullet, no body section
    const bulletOnly = composeSystemPrompt(developerSystemPromptBase(), [{ name: 'developer.ponytail-lazy' }], '');
    expect(bulletOnly).not.toContain('## Skill procedures');
    expect(bulletOnly).not.toContain('minimum code that works');
  });

  it('reviewer prompt contains the ponytail-review body (WORK 0 wire)', () => {
    const composed = composeReviewerSystemPrompt(repoRoot);
    expect(composed).toContain('## Skill procedures');
    expect(composed).toContain('Lean already. Ship.');       // an actual review-skill line
    expect(composed).toContain('Never flag the ponytail minimum');
  });
});

describe('STORY-UST.4 WORK 1 — executor↔introspection isomorphism (byte-identical)', () => {
  for (const role of ['developer', 'reviewer'] as const) {
    it(`${role}: introspection composes byte-identically to the executor`, () => {
      const base = role === 'developer' ? developerSystemPromptBase() : reviewerSystemPromptBase();
      const docs = envelopeDocsForRole(role);

      // Executor path: skill-runtime loader → shared composeSystemPrompt
      const executorPrompt = composeSystemPrompt(base, executorSkills(role), docs);

      // Introspection path: harness-core's loader-backed refs → the SAME injected composeSystemPrompt
      const view = getAgentPromptView(role,
        { base, mounted_skills: mountedSkillsForRole(role, repoRoot), envelope_docs: docs },
        { compose: composeSystemPrompt });

      expect(view.composed).toBe(executorPrompt); // BYTE-IDENTICAL — the isomorphism invariant
    });
  }
});
