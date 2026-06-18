/**
 * Plan §3 — Contract-first Planning. Planning is the deterministic Contract Compiler:
 * every generated story carries a COMPLETE 7-element contract before development, and
 * the bundle gate rejects any story missing an element. Inventory found 6/7 already
 * present; §3 adds the 7th (context_packet) and the full-contract gate. Planning stays
 * 0 askModel (pure/deterministic) — proven here by determinism, not mocked.
 */
import { describe, it, expect } from 'vitest';
import {
  generateBacklogFromPlanningBundle,
  validateStoryContractComplete,
  assertStoriesCarryFullContract,
  buildStoryContextPacket,
  CONTRACT_ELEMENTS,
  type GeneratedStory,
} from './index';

const BUNDLE = {
  bundle_id: 'bundle-todo',
  idea_id: 'todo-1',
  prd: {
    title: 'Todo CLI',
    problem_statement: 'users need a simple todo list at the terminal',
    users: ['developers'],
    goals: ['add and list tasks'],
    non_goals: ['cloud sync'],
  },
  architecture: {
    summary: 'standalone CLI; independent module boundaries.',
    components: ['core', 'cli'],
    constraints: ['no external dependencies'],
    risks: ['scope creep'],
  },
  open_decisions: [],
  source_refs: [],
};

describe('§3 — every generated story carries a complete 7-element contract', () => {
  it('all seven contract elements are present on every generated story', () => {
    const backlog = generateBacklogFromPlanningBundle(BUNDLE as never);
    expect(backlog.stories.length).toBeGreaterThan(0);
    for (const s of backlog.stories) {
      expect(validateStoryContractComplete(s)).toEqual([]);     // nothing missing
      // explicitly: the 7th element (context packet) is now authored
      expect(s.context_packet.include_refs).toContain(`story_contract:${s.story_id}`);
      expect(s.context_packet.exclude_patterns).toContain('**/.env*');
    }
    expect(CONTRACT_ELEMENTS.length).toBe(7);
  });

  it('context packet is deterministic (no LLM, no randomness)', () => {
    const a = generateBacklogFromPlanningBundle(BUNDLE as never);
    const b = generateBacklogFromPlanningBundle(BUNDLE as never);
    expect(a).toEqual(b);                                        // same bundle → identical backlog
    expect(buildStoryContextPacket({ story_id: 'X', epic_id: 'E' }))
      .toEqual(buildStoryContextPacket({ story_id: 'X', epic_id: 'E' }));
  });
});

describe('§3 — the bundle gate rejects an incomplete contract', () => {
  const complete = (): Partial<GeneratedStory> & { story_id: string } => ({
    story_id: 'S1', epic_id: 'E1', objective: 'do a thing',
    acceptance_intent: { authored_at: 'planning', behaviors: [{ id: 'does_a_thing', kind: 'behavior', target: 'thing' }] },
    allowed_write_set: ['core.mjs'], forbidden_actions: ['no secrets'],
    validation_commands: ['node --test'], rollback_notes: ['revert'],
    context_packet: { include_refs: ['story_contract:S1'], exclude_patterns: ['**/.env*'] },
  });

  it('a complete story passes the gate', () => {
    expect(() => assertStoriesCarryFullContract([complete()])).not.toThrow();
    expect(validateStoryContractComplete(complete())).toEqual([]);
  });

  it('missing the context packet (the 7th element) is rejected', () => {
    const s = complete(); delete (s as Record<string, unknown>).context_packet;
    expect(validateStoryContractComplete(s)).toContain('context_packet');
    expect(() => assertStoriesCarryFullContract([s])).toThrow(/incomplete contract.*context_packet/);
  });

  it('missing rollback_notes is rejected', () => {
    const s = complete(); s.rollback_notes = [];
    expect(() => assertStoriesCarryFullContract([s])).toThrow(/incomplete contract.*rollback_notes/);
  });

  it('an empty/prose acceptance_intent is rejected', () => {
    const s = complete(); s.acceptance_intent = { authored_at: 'planning', behaviors: [] } as never;
    expect(validateStoryContractComplete(s)).toContain('acceptance_intent');
  });
});
