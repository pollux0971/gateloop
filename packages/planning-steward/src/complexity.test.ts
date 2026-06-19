/**
 * WORK 3a — Planning authors estimated_complexity DETERMINISTICALLY (no LLM), the
 * signal the deterministic router selects a model on. Same inputs → same tier.
 */
import { describe, it, expect } from 'vitest';
import { estimateStoryComplexity, generateBacklogFromPlanningBundle } from './index';

describe('WORK 3a — estimateStoryComplexity is deterministic and tiered', () => {
  it('maps write-set size + behaviors to a tier', () => {
    expect(estimateStoryComplexity({ allowed_write_set: ['a.mjs'], behaviorCount: 0 })).toBe('trivial'); // 2
    expect(estimateStoryComplexity({ allowed_write_set: ['a.mjs'], behaviorCount: 3 })).toBe('small');   // 5
    expect(estimateStoryComplexity({ allowed_write_set: ['a.mjs', 'b.mjs'], behaviorCount: 4 })).toBe('medium'); // 8
    expect(estimateStoryComplexity({ allowed_write_set: ['a', 'b', 'c'], behaviorCount: 6 })).toBe('large');     // 12
    expect(estimateStoryComplexity({ allowed_write_set: ['a', 'b', 'c', 'd'], behaviorCount: 8 })).toBe('xlarge'); // 16
  });

  it('is reproducible (same input → same tier)', () => {
    const inp = { allowed_write_set: ['x', 'y'], behaviorCount: 5 };
    expect(estimateStoryComplexity(inp)).toBe(estimateStoryComplexity(inp));
  });
});

describe('WORK 3a — generated backlog carries estimated_complexity', () => {
  const BUNDLE = {
    bundle_id: 'bundle-todo', idea_id: 'todo-1',
    prd: { title: 'Todo CLI', problem_statement: 'terminal todo', users: ['devs'], goals: ['add tasks'], non_goals: ['sync'] },
    architecture: { summary: 'cli', components: ['core', 'cli'], constraints: ['none'], risks: ['scope'] },
    open_decisions: [], source_refs: [],
  };

  it('every story has a valid complexity tier', () => {
    const backlog = generateBacklogFromPlanningBundle(BUNDLE as never);
    const tiers = ['trivial', 'small', 'medium', 'large', 'xlarge'];
    for (const s of backlog.stories) expect(tiers).toContain(s.estimated_complexity);
    // determinism: regenerate → identical
    expect(generateBacklogFromPlanningBundle(BUNDLE as never)).toEqual(backlog);
  });
});
