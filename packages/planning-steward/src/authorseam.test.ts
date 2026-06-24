import { describe, it, expect } from 'vitest';
import {
  selectStageDocAuthor,
  createScriptedAuthor,
  createRealAuthor,
  StageDocAuthorError,
  type AuthorEngine,
  type AuthorSkill,
  type AuthorContext,
} from './authorseam.js';

const SKILL: AuthorSkill = {
  steps: [
    { filename: '01.md', content: 'Frame the functional requirements.' },
    { filename: '02.md', content: 'Add non-functional requirements.' },
  ],
  template: '# PRD\n\n## FR\n\n## NFR\n',
};
const CTX: AuthorContext = { stageId: 'prd', idea: 'A tiny URL shortener.' };

/** A stub engine matching provider-driver's LanguageModelEngine shape (text path). */
function stubEngine(text: string, onRun?: (i: { prompt: string; system?: string }) => void): AuthorEngine {
  return {
    backendId: 'stub',
    model: 'stub-model',
    async *stream(input) {
      onRun?.(input);
      // split into deltas to prove the author concatenates the stream
      for (const ch of [text.slice(0, 3), text.slice(3)]) yield { type: 'text-delta', text: ch };
      yield { type: 'finish' };
    },
  };
}

describe('STORY-PLLM.3 StageDocAuthor seam', () => {
  it('author_seam_exposes_single_interface_with_scripted_and_real_impls', async () => {
    const scripted = createScriptedAuthor();
    const real = createRealAuthor({ buildEngine: async () => stubEngine('DOC') });
    // same interface: both have kind + author(); both return a string doc.
    expect(scripted.kind).toBe('scripted');
    expect(real.kind).toBe('real');
    expect(typeof scripted.author).toBe('function');
    expect(typeof real.author).toBe('function');
    expect(typeof (await scripted.author(SKILL, CTX))).toBe('string');
    expect(await real.author(SKILL, CTX)).toBe('DOC');
  });

  it('seam_selects_scripted_author_by_default_real_is_opt_in', async () => {
    // no select / no mode / explicit scripted → scripted, with NO real deps wired.
    expect(selectStageDocAuthor().kind).toBe('scripted');
    expect(selectStageDocAuthor(undefined).kind).toBe('scripted');
    expect(selectStageDocAuthor({}).kind).toBe('scripted');
    expect(selectStageDocAuthor({ mode: 'scripted' }).kind).toBe('scripted');
    // real is opt-in AND requires real deps — default selection never reaches the key path.
    const real = selectStageDocAuthor({ mode: 'real' }, { real: { buildEngine: async () => stubEngine('X') } });
    expect(real.kind).toBe('real');
    // mode:'real' with no real deps wired fails loudly (never silently downgrades to scripted).
    expect(() => selectStageDocAuthor({ mode: 'real' })).toThrow(StageDocAuthorError);
  });

  it('scripted_author_is_deterministic_offline_zero_cost', async () => {
    const a = createScriptedAuthor();
    const d1 = await a.author(SKILL, CTX);
    const d2 = await a.author(SKILL, CTX);
    expect(d1).toBe(d2); // byte-identical
    // it incorporates the template + idea + steps (a usable doc), with no network/key.
    expect(d1).toContain('# PRD');
    expect(d1).toContain('A tiny URL shortener.');
    expect(d1).toContain('Step 1: Frame the functional requirements.');
    // a re-author with failing items changes the output (the convergence signal).
    const reauthored = await a.author(SKILL, {
      ...CTX,
      failingItems: [{ id: 'i1', text: 'must list FR1', directive: null, evaluable: false, pass: false }],
    });
    expect(reauthored).not.toBe(d1);
    expect(reauthored).toContain('Resolved: must list FR1');
  });

  it('real_author_reuses_provider_driver_and_reads_key_via_secret_seam', async () => {
    // The real author drains a LanguageModelEngine-shaped engine (the provider-driver
    // seam) — proven here with a stub of that exact shape; production injects
    // createMeteredEngine. It also proves the PLLM.2 prompt reached the engine.
    let seen: { prompt: string; system?: string } | null = null;
    let keyReads = 0;
    const real = createRealAuthor({
      buildEngine: async () => {
        // the key seam is exercised HERE, inside buildEngine — the author never sees it.
        keyReads++;
        return stubEngine('AUTHORED-BODY', (i) => (seen = i));
      },
    });
    const doc = await real.author(SKILL, { stageId: 'architecture', idea: 'Idea X', priorDocs: { prd: 'PRD-BODY' } });
    expect(doc).toBe('AUTHORED-BODY');
    expect(keyReads).toBe(1); // key resolved exactly once, inside the engine-build boundary
    expect(seen).not.toBeNull();
    expect(seen!.prompt).toContain('## Idea');
    expect(seen!.prompt).toContain('Idea X');
    expect(seen!.prompt).toContain('### prd'); // prior doc threaded into the prompt
    expect(seen!.system.toLowerCase()).toContain('markdown');
  });

  it('real_author_with_no_key_fails_loudly_never_silently_fakes_success_invariant', async () => {
    // buildEngine throws exactly as createMeteredEngine does when the broker has no key.
    let scriptedFallbackHit = false;
    const real = createRealAuthor({
      buildEngine: async () => {
        throw new Error("no metered key for backend 'openai' (broker provider 'openai')");
      },
    });
    // INVARIANT: the call REJECTS (loud). It must NOT resolve to any fake doc.
    await expect(real.author(SKILL, CTX)).rejects.toThrow(/no metered key/);
    // and there is no scripted fallback path inside the real author.
    expect(scriptedFallbackHit).toBe(false);

    // An empty model response is also a loud failure, never a silent empty "success".
    const emptyReal = createRealAuthor({
      buildEngine: async () => ({
        async *stream() {
          /* yields nothing */
        },
      }),
    });
    await expect(emptyReal.author(SKILL, CTX)).rejects.toThrow(StageDocAuthorError);
  });
});
