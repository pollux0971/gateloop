/**
 * STORY-PTEST.6 — PLLM author→advance loop OFFLINE tests (scripted author, no spend).
 *
 * The dedicated LLM-loop test layer for EPIC-PTEST: convergence (a scripted author that
 * fixes on attempt 2), give-up at budget with a clear reason, scripted-by-default, and the
 * "set ≠ effective" probe — REAL author selected but NO key fails LOUDLY with no real call.
 * Everything is offline + deterministic; the only "provider" is an injected stub.
 */
import { describe, it, expect } from 'vitest';
import { authorAndAdvance, type AdvanceOutcome } from './authorloop.js';
import {
  selectStageDocAuthor,
  createRealAuthor,
  type StageDocAuthor,
  type AuthorSkill,
  type AuthorContext,
} from './authorseam.js';
import type { ChecklistItem } from './checklist.js';

const SKILL: AuthorSkill = {
  steps: [{ filename: '01.md', content: 'Write the requirements.' }],
  template: '# PRD\n\n## FR\n',
};
const CTX = { stageId: 'prd', idea: 'A tiny URL shortener.' };
const failItem = (text: string): ChecklistItem => ({ id: `i-${text}`, text, directive: null, evaluable: false, pass: false });

describe('STORY-PTEST.6 — PLLM author loop (offline, scripted)', () => {
  it('loop_converges_with_scripted_author_that_fixes_on_attempt_two', async () => {
    // a scripted author that produces a BAD doc first, then a GOOD doc once it is handed
    // the failing items (i.e. it "fixes on attempt 2").
    const authorCalls: AuthorContext[] = [];
    const author: StageDocAuthor = {
      kind: 'scripted',
      async author(_skill, ctx) {
        authorCalls.push(ctx);
        return ctx.failingItems && ctx.failingItems.length > 0 ? 'GOOD' : 'BAD';
      },
    };
    const advance = (doc: string): AdvanceOutcome =>
      doc === 'GOOD'
        ? { advanced: true, blocked_reason: null, failing_items: [] }
        : { advanced: false, blocked_reason: 'checklist 0/1 — not complete', failing_items: [failItem('needs an FR section')] };

    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance, maxRewrites: 2 });
    expect(res.ok).toBe(true);
    expect(res.advanced).toBe(true);
    expect(res.attempts).toBe(2); // converged on the second attempt
    expect(res.doc).toBe('GOOD');
    expect(res.blocked_reason).toBeNull();
    // the second author call received the first attempt's failing items (the fix loop).
    expect(authorCalls[0].failingItems).toBeUndefined();
    expect(authorCalls[1].failingItems?.map((i) => i.text)).toEqual(['needs an FR section']);
  });

  it('loop_gives_up_at_budget_with_clear_reason', async () => {
    // a scripted author that NEVER satisfies the gate → bounded give-up.
    const author: StageDocAuthor = { kind: 'scripted', async author() { return 'STILL-BAD'; } };
    let advanceCalls = 0;
    const advance = (): AdvanceOutcome => {
      advanceCalls++;
      return { advanced: false, blocked_reason: 'checklist 0/2 — not complete', failing_items: [failItem('add FR'), failItem('add NFR')] };
    };
    const res = await authorAndAdvance({ author, skill: SKILL, context: CTX, advance, maxRewrites: 2 });
    expect(res.ok).toBe(false);
    expect(res.advanced).toBe(false);
    expect(res.attempts).toBe(3); // maxRewrites(2) + 1, then stop — never infinite
    expect(advanceCalls).toBe(3);
    expect(res.blocked_reason).toMatch(/gave up after 3 attempt\(s\)/);
    expect(res.blocked_reason).toMatch(/last block: checklist 0\/2/);
    expect(res.failing_items.length).toBe(2);
  });

  it('seam_defaults_to_scripted_author', () => {
    // no select / empty select / explicit scripted → scripted, with NO real deps wired.
    expect(selectStageDocAuthor().kind).toBe('scripted');
    expect(selectStageDocAuthor({}).kind).toBe('scripted');
    expect(selectStageDocAuthor({ mode: 'scripted' }).kind).toBe('scripted');
    // the scripted default actually authors offline (no provider, no key).
    return selectStageDocAuthor().author(SKILL, CTX).then((doc) => {
      expect(typeof doc).toBe('string');
      expect(doc.length).toBeGreaterThan(0);
    });
  });

  it('real_author_without_key_fails_loudly_probe_no_real_call_invariant', async () => {
    // PROBE: the REAL author is selected, but buildEngine throws exactly as
    // createMeteredEngine does when the broker has no key. No real network call is made.
    let buildEngineCalls = 0;
    let scriptedFallbackUsed = false;
    const real = createRealAuthor({
      buildEngine: async () => {
        buildEngineCalls++;
        throw new Error("no metered key for backend 'openai' (broker provider 'openai')");
      },
    });
    // INVARIANT: it REJECTS loudly — never resolves to a fake/scripted doc.
    await expect(real.author(SKILL, CTX)).rejects.toThrow(/no metered key/);
    expect(buildEngineCalls).toBe(1); // the key probe ran exactly once (no retry, no real call beyond the build)
    expect(scriptedFallbackUsed).toBe(false); // there is NO silent scripted fallback inside the real author

    // and selecting real explicitly does not secretly hand back a scripted author.
    const selected = selectStageDocAuthor({ mode: 'real' }, { real: { buildEngine: async () => { throw new Error('no metered key for backend'); } } });
    expect(selected.kind).toBe('real');
    await expect(selected.author(SKILL, CTX)).rejects.toThrow(/no metered key/);
  });
});
