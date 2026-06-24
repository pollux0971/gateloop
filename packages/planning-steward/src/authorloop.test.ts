import { describe, it, expect } from 'vitest';
import { authorAndAdvance, type AdvanceOutcome } from './authorloop.js';
import type { StageDocAuthor, AuthorSkill, AuthorContext } from './authorseam.js';
import type { ChecklistItem } from './checklist.js';

const SKILL: AuthorSkill = {
  steps: [{ filename: '01.md', content: 'Write the requirements.' }],
  template: '# PRD\n\n## FR\n',
};
const CTX = { stageId: 'prd', idea: 'A tiny URL shortener.' };

function failItem(text: string): ChecklistItem {
  return { id: `i-${text}`, text, directive: null, evaluable: false, pass: false };
}

/** A scripted author that records the contexts it was called with. */
function recordingAuthor(produce: (ctx: AuthorContext, call: number) => string): {
  author: StageDocAuthor;
  calls: AuthorContext[];
} {
  const calls: AuthorContext[] = [];
  const author: StageDocAuthor = {
    kind: 'scripted',
    async author(_skill, ctx) {
      calls.push(ctx);
      return produce(ctx, calls.length);
    },
  };
  return { author, calls };
}

describe('STORY-PLLM.4 author→advance loop', () => {
  it('blocked_advance_feeds_failing_items_back_and_re_authors', async () => {
    const { author, calls } = recordingAuthor(() => 'doc');
    // advance blocks once (returning failing items), then converges.
    let n = 0;
    const advance = (): AdvanceOutcome => {
      n++;
      return n === 1
        ? { advanced: false, blocked_reason: 'checklist 1/2 — not complete', failing_items: [failItem('add an FR section')] }
        : { advanced: true, blocked_reason: null, failing_items: [] };
    };
    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    // the FIRST author call had no failing items; the SECOND received the block's items.
    expect(calls[0].failingItems).toBeUndefined();
    expect(calls[1].failingItems?.map((i) => i.text)).toEqual(['add an FR section']);
  });

  it('loop_converges_when_scripted_author_fixes_doc_within_budget', async () => {
    // A scripted author that produces a BAD doc first, then a GOOD doc once it sees
    // failing items — mirrors "fixes the doc on attempt 2".
    const author: StageDocAuthor = {
      kind: 'scripted',
      async author(_skill, ctx) {
        return ctx.failingItems && ctx.failingItems.length > 0 ? 'GOOD' : 'BAD';
      },
    };
    const advance = (doc: string): AdvanceOutcome =>
      doc === 'GOOD'
        ? { advanced: true, blocked_reason: null, failing_items: [] }
        : { advanced: false, blocked_reason: 'checklist 0/1 — not complete', failing_items: [failItem('needs content')] };

    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance, maxRewrites: 2 });
    expect(res.ok).toBe(true);
    expect(res.advanced).toBe(true);
    expect(res.attempts).toBe(2); // converged within budget
    expect(res.doc).toBe('GOOD');
    expect(res.blocked_reason).toBeNull();
  });

  it('loop_gives_up_with_clear_reason_at_attempt_budget', async () => {
    // A scripted author that NEVER fixes the doc → the loop gives up cleanly.
    const author: StageDocAuthor = { kind: 'scripted', async author() { return 'STILL-BAD'; } };
    let advanceCalls = 0;
    const advance = (): AdvanceOutcome => {
      advanceCalls++;
      return { advanced: false, blocked_reason: 'checklist 0/1 — not complete', failing_items: [failItem('needs content')] };
    };
    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance, maxRewrites: 2 });
    expect(res.ok).toBe(false);
    expect(res.advanced).toBe(false);
    expect(res.attempts).toBe(3); // maxRewrites(2) + 1
    expect(advanceCalls).toBe(3); // bounded — does not loop forever
    expect(res.blocked_reason).toMatch(/gave up after 3 attempt\(s\)/);
    expect(res.blocked_reason).toMatch(/last block: checklist 0\/1/);
    expect(res.failing_items.length).toBeGreaterThan(0);
  });

  it('loop_is_bounded_even_with_maxRewrites_zero', async () => {
    // maxRewrites:0 → exactly one attempt, no re-author.
    const { author, calls } = recordingAuthor(() => 'doc');
    const advance = (): AdvanceOutcome => ({ advanced: false, blocked_reason: 'no', failing_items: [] });
    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance, maxRewrites: 0 });
    expect(res.attempts).toBe(1);
    expect(calls.length).toBe(1);
    expect(res.ok).toBe(false);
  });
});
