/**
 * STORY-UST.4 WORK 2 (gated) — the ONE real-model A/B that proves ponytail behaviourally
 * reduces code. Same coding task, two arms — system WITHOUT vs WITH the registered
 * ponytail-lazy SKILL.md body (the exact text the UST.1 wire injects) — on a real metered
 * model. This mirrors ponytail's own published benchmark method: single-shot completion,
 * LOC counted from the fenced code block, plus a structural correctness check.
 *
 * The three-fold: code↓ (ON loc ≤ OFF loc) ∧ correctness held (both produce a real
 * debounce: setTimeout + clearTimeout) ∧ no added friction (ON keeps the core; it didn't
 * drop required behaviour to look shorter).
 *
 * Spend is gated: runGated opens real_api_calls, runs both arms, closes + read-back
 * verifies. Key via the Secret Broker (a child sources .env; this code never reads it).
 * Budget-capped; expected « $1.
 */
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { pickMeteredBackend, resolveMeteredKey, createMeteredEngine } from '@gateloop/provider-driver';
import { runGated, BudgetLedger } from '@gateloop/gate-control';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';
import { makeMeteredBroker, POLICY_PATH, METERED_BACKEND } from './provider-mode-metered.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// A task with a known over-build trap (debounce — baselines often pile on leading/trailing/
// maxWait options; lazy ships the minimal correct closure). Same prompt to both arms.
export const AB_TASK =
  'Write a JavaScript debounce(fn, ms) function. Return ONLY the implementation in a single ' +
  'fenced ```js code block, no prose.';

const BASE_SYSTEM = 'You are a senior JavaScript developer.';

/** The ponytail-lazy SKILL.md body — exactly what the UST.1 wire mounts (frontmatter stripped). */
export function ponytailBody(): string {
  const skills = loadMountedSkillsForRole('developer', repoRoot);
  const pony = skills.find(s => s.name === 'developer.ponytail-lazy');
  if (!pony) throw new Error('developer.ponytail-lazy not registered — run UST.2 first');
  return pony.body;
}

/** Lines of code inside the first fenced block (non-blank). Falls back to whole text. */
export function locOfCodeBlock(text: string): number {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  const code = m ? m[1] : text;
  return code.split('\n').filter(l => l.trim().length > 0).length;
}

/** Structural correctness: a real debounce uses a timer it can cancel. */
export function isRealDebounce(text: string): boolean {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  const code = (m ? m[1] : text).toLowerCase();
  return code.includes('settimeout') && code.includes('cleartimeout');
}

export interface ArmOut { loc: number; correct: boolean; chars: number }
export interface AbGatedResult {
  ran: boolean;
  off?: ArmOut;
  on?: ArmOut;
  verdict?: { loc_not_increased: boolean; correctness_held: boolean; both_correct: boolean; three_fold_pass: boolean };
  usage?: unknown;
  gateClosedVerified?: boolean;
  reason?: string;
}

async function genOnce(engine: { stream: (i: { prompt: string; system: string }) => AsyncIterable<{ type: string; text?: string; usage?: unknown }> }, system: string): Promise<{ text: string; usage?: unknown }> {
  let text = ''; let usage: unknown;
  for await (const part of engine.stream({ prompt: AB_TASK, system })) {
    if (part.type === 'text-delta') text += part.text ?? '';
    if (part.type === 'finish') usage = part.usage;
  }
  return { text, usage };
}

export async function runPonytailAbGated(opts: { modelId?: string; envFile?: string; budgetUsd?: number } = {}): Promise<AbGatedResult> {
  const spec = pickMeteredBackend(METERED_BACKEND);
  const modelId = opts.modelId ?? process.env.METERED_MODEL ?? spec.defaultModel;
  const broker = makeMeteredBroker(opts.envFile);
  const budget = new BudgetLedger(opts.budgetUsd ?? 1);

  const engine = await createMeteredEngine({
    spec, model: modelId, broker, streamText,
    modelFactory: (apiKey: string, m: string) => createOpenAI({ apiKey }).responses(m),
  });

  let off: ArmOut | undefined; let on: ArmOut | undefined; let usage: unknown;
  const gated = await runGated(async () => {
    const offRes = await genOnce(engine as never, BASE_SYSTEM);
    const onRes = await genOnce(engine as never, `${BASE_SYSTEM}\n\n${ponytailBody()}`);
    off = { loc: locOfCodeBlock(offRes.text), correct: isRealDebounce(offRes.text), chars: offRes.text.length };
    on = { loc: locOfCodeBlock(onRes.text), correct: isRealDebounce(onRes.text), chars: onRes.text.length };
    usage = { off: offRes.usage, on: onRes.usage };
    return true;
  }, { policyPath: POLICY_PATH, budget, env: { CI: process.env.CI } });

  const verdict = off && on ? {
    loc_not_increased: on.loc <= off.loc,
    correctness_held: on.correct === true,
    both_correct: off.correct && on.correct,
    three_fold_pass: on.loc <= off.loc && on.correct && off.correct,
  } : undefined;

  return { ran: gated.ran, off, on, verdict, usage, gateClosedVerified: gated.gateClosedVerified, reason: gated.reason };
}
