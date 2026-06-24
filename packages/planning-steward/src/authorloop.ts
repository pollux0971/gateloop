/**
 * @gateloop/planning-steward — Author→advance rewrite loop (STORY-PLLM.4).
 *
 * The deterministic core of the server-side loop: for one stage, author a document
 * (via the StageDocAuthor seam — scripted by default), submit it to the existing
 * checklist-gated advance, and — if blocked — feed the returned failing_items back
 * into the next authoring attempt (PLLM.2's "Fix these issues" block), up to a bounded
 * rewrite budget. Converges (advanced) or gives up with a clear reason.
 *
 * This function is pure orchestration: it takes the author and an `advance` callback,
 * so it is fully offline-testable with the scripted author (a scripted author that
 * fixes the doc on attempt 2 → converges; one that never fixes → gives up). The real
 * provider path differs only in which author is injected. Design: docs/architecture/28 §3.2.
 */
import type { StageDocAuthor, AuthorSkill, AuthorContext } from './authorseam.js';
import type { ChecklistItem } from './checklist.js';

/** The outcome of submitting a document to the checklist gate (a slice of advance()). */
export interface AdvanceOutcome {
  advanced: boolean;
  blocked_reason: string | null;
  failing_items: ChecklistItem[];
}

export interface AuthorAndAdvanceInput {
  author: StageDocAuthor;
  skill: AuthorSkill;
  context: { stageId: string; idea: string; priorDocs?: Record<string, string> };
  /** Submit a document to the checklist gate; returns whether it advanced + any failing items. */
  advance(doc: string): AdvanceOutcome | Promise<AdvanceOutcome>;
  /** Max RE-authoring attempts after the first (default 2 → up to 3 author calls total). */
  maxRewrites?: number;
  signal?: AbortSignal;
}

export interface AuthorAndAdvanceResult {
  /** Converged: the stage advanced within budget. */
  ok: boolean;
  /** Number of author() calls made (1 = converged first try). */
  attempts: number;
  /** The last document authored. */
  doc: string;
  advanced: boolean;
  /** On give-up, a clear reason; null on convergence. */
  blocked_reason: string | null;
  failing_items: ChecklistItem[];
}

/**
 * Run the author→advance loop for one stage. Each attempt authors a doc (feeding the
 * previous attempt's failing_items back on a re-author), then advances. Stops on the
 * first convergence, or after `maxRewrites + 1` attempts with a give-up reason.
 */
export async function authorAndAdvance(input: AuthorAndAdvanceInput): Promise<AuthorAndAdvanceResult> {
  const maxRewrites = input.maxRewrites ?? 2;
  const totalAttempts = Math.max(1, maxRewrites + 1);

  let failing: ChecklistItem[] = [];
  let doc = '';
  let lastReason: string | null = null;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const ctx: AuthorContext = {
      stageId: input.context.stageId,
      idea: input.context.idea,
      priorDocs: input.context.priorDocs,
      // failing_items are present only on a re-author (PLLM.2 "Fix these issues").
      failingItems: failing.length > 0 ? failing : undefined,
    };
    doc = await input.author.author(input.skill, ctx, { signal: input.signal });
    const outcome = await input.advance(doc);
    if (outcome.advanced) {
      return { ok: true, attempts: attempt, doc, advanced: true, blocked_reason: null, failing_items: [] };
    }
    failing = outcome.failing_items ?? [];
    lastReason = outcome.blocked_reason;
  }

  return {
    ok: false,
    attempts: totalAttempts,
    doc,
    advanced: false,
    blocked_reason:
      `gave up after ${totalAttempts} attempt(s)` + (lastReason ? ` — last block: ${lastReason}` : ''),
    failing_items: failing,
  };
}
