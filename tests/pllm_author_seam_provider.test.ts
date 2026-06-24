/**
 * STORY-PLLM.3 — genuine cross-package proof that the REAL StageDocAuthor reuses
 * @gateloop/provider-driver (its engine seam) and reads the key via the
 * @gateloop/secret-broker secret seam — with NO real provider spend.
 *
 * The in-package suite (planning-steward/src/authorseam.test.ts) covers the seam
 * with stubs; this root test wires the ACTUAL provider-driver + secret-broker
 * modules to the real author, so "reuses provider-driver + reads key via the secret
 * seam" and "no key → fails loud" are proven against the real code paths production
 * uses (createMeteredEngine resolves the key inside its closure; the AI SDK is
 * injected, so no network is touched).
 */
import { describe, it, expect } from 'vitest';
import { createRealAuthor, type AuthorSkill, type AuthorContext } from '@gateloop/planning-steward';
import {
  createScriptedEngine,
  createMeteredEngine,
  pickMeteredBackend,
} from '@gateloop/provider-driver';
import { SecretBroker, type SecretSource } from '@gateloop/secret-broker';

const SKILL: AuthorSkill = {
  steps: [{ filename: '01.md', content: 'Frame the requirements.' }],
  template: '# PRD\n\n## FR\n',
};
const CTX: AuthorContext = { stageId: 'prd', idea: 'A tiny URL shortener.' };

/** A fake AI-SDK streamText that yields one text part then finishes — zero network. */
function makeFakeStreamText() {
  return (opts: { prompt?: string }) => ({
    fullStream: (async function* () {
      yield { type: 'text-delta', text: `AUTHORED(${(opts.prompt ?? '').includes('## Idea') ? 'with-idea' : 'no-idea'})` };
      yield { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 3 } };
    })(),
  });
}

/** A secret source with a controllable key (empty string = no key configured). */
function source(key: string): SecretSource {
  return { read: () => key };
}

describe('STORY-PLLM.3 real author × provider-driver × secret-broker (offline)', () => {
  it('real_author_drains_a_real_provider_driver_engine', async () => {
    // buildEngine returns a genuine provider-driver scriptedEngine (the LanguageModelEngine seam).
    const real = createRealAuthor({
      buildEngine: async () =>
        createScriptedEngine({
          parts: [
            { type: 'text-delta', text: 'REAL-' },
            { type: 'text-delta', text: 'DOC' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
          ],
        }),
    });
    expect(await real.author(SKILL, CTX)).toBe('REAL-DOC');
  });

  it('real_author_reads_key_via_secret_broker_then_authors_through_metered_engine', async () => {
    // The FULL production path: secret-broker resolves a key → provider-driver
    // createMeteredEngine builds the engine inside its closure → real author drains it.
    const broker = new SecretBroker(source('sk-test-KEY-value-1234'));
    const real = createRealAuthor({
      buildEngine: async () =>
        createMeteredEngine({
          spec: pickMeteredBackend('openai'),
          broker,
          streamText: makeFakeStreamText() as never,
          modelFactory: (apiKey: string, modelId: string) => ({ apiKey, modelId }),
        }),
    });
    const doc = await real.author(SKILL, CTX);
    expect(doc).toContain('AUTHORED(with-idea)'); // the PLLM.2 prompt reached the engine
    expect(broker.resolvedCount()).toBe(1); // the key was resolved via the broker exactly once
  });

  it('real_author_with_no_key_fails_loudly_via_the_real_secret_seam_invariant', async () => {
    // Empty source = no .env key. createMeteredEngine throws inside buildEngine; the
    // author propagates it — no fake success, no scripted fallback.
    const broker = new SecretBroker(source(''));
    const real = createRealAuthor({
      buildEngine: async () =>
        createMeteredEngine({
          spec: pickMeteredBackend('openai'),
          broker,
          streamText: makeFakeStreamText() as never,
          modelFactory: (apiKey: string, modelId: string) => ({ apiKey, modelId }),
        }),
    });
    await expect(real.author(SKILL, CTX)).rejects.toThrow(/no metered key/);
  });
});
