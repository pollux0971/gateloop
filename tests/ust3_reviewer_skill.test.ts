/**
 * STORY-UST.3 — ponytail-review is a registered reviewer skill that mounts with its
 * body via the same UST.1 wire (loadMountedSkillsForRole), against the REAL catalog.
 * Offline/scripted; no model, no network.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';

const repoRoot = fileURLToPath(new URL('../', import.meta.url)); // tests/ → gateloop/

describe('STORY-UST.3 ponytail-review reviewer skill', () => {
  it('loads as a registered reviewer skill with the over-engineering review body', () => {
    const mounted = loadMountedSkillsForRole('reviewer', repoRoot);
    const pony = mounted.find(m => m.name === 'reviewer.ponytail-review');
    expect(pony).toBeDefined();
    // body reached the mount (the UST.1 wire), not just a name bullet
    expect(pony!.body.toLowerCase()).toContain('over-engineering');
    expect(pony!.body).toContain('Lean already. Ship.');
    // same additive-gate coordination as UST.2 (no authorizing removal of existing behavior)
    expect(pony!.body.toLowerCase()).toContain('additive gate');
    expect(pony!.body).toContain('Never flag the ponytail minimum');
    // host cruft stripped
    expect(pony!.body.toLowerCase()).not.toContain('claude code');
  });
});
