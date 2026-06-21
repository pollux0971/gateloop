/**
 * @gateloop/agent-core — composeSystemPrompt (STORY-032.3, extended STORY-UST.1)
 *
 * The SINGLE pure function that composes an agent's system prompt from:
 *   base template + mounted skills + the envelope-format docs (032.2).
 *
 * It is shared by BOTH the executor (askModel — live instance input) and the
 * read-only introspection endpoint (032.4 — config-representative input). They
 * differ ONLY in input, never in composition logic. That is the correctness
 * anchor of the static asset browser: what you view is composed the same way as
 * what the model receives — without being a trace snapshot.
 * Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md
 *
 * STORY-UST.1 — the wire: a MountedSkill may now carry the skill's SKILL.md `body`
 * (+ `avoid` lines). Before this, only `name`/`summary` reached the model — the
 * SKILL.md procedure was authored, tested, registered, and then never sent (the
 * set≠effective gap, ADR-024 §1.3 / ADR-023 §2.3). composeSystemPrompt now injects
 * the body itself, ADDITIVELY (the `## Mounted skills` bullet index is unchanged; a
 * new `## Skill procedures` section carries the bodies). Bodies are emitted in the
 * order given (callers pass them dependency-ordered) and capped by a token budget so
 * a large skill set cannot blow the context window. The budget default lives HERE, in
 * the shared function, so the executor and the introspection view stay isomorphic
 * without either caller having to thread the same number through.
 */

export interface MountedSkill {
  name: string;
  /** Optional one-line summary shown in the bullet index. */
  summary?: string;
  /** STORY-UST.1: the skill's SKILL.md procedure body. When present it is injected
   *  under `## Skill procedures` (not just listed as a bullet). */
  body?: string;
  /** STORY-UST.1: compact `AVOID:` lessons from the skill's .memory.md, injected
   *  with the body so banked failure genes reach the model. */
  avoid?: string[];
}

/** STORY-UST.1: default cap on injected skill-procedure text, in estimated tokens
 *  (~chars/4, the convention shared with context-manager + readSkillContent). Generous
 *  enough that a normal skill set is injected in full; it only bites a pathological
 *  pile-up of large skills. Lives here so both compose callers share one default →
 *  executor↔introspection isomorphism holds with no param threading. */
export const DEFAULT_SKILL_BODY_TOKEN_BUDGET = 16000;

export interface ComposeSystemPromptOptions {
  /** Override the skill-body token budget (defaults to DEFAULT_SKILL_BODY_TOKEN_BUDGET).
   *  Both compose callers must pass the SAME value (or neither) to stay isomorphic. */
  skillBodyTokenBudget?: number;
}

/** Estimated tokens for a string — chars/4, the convention used across the harness. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Render one skill's procedure block: heading + body + any AVOID lessons. */
function renderSkillBody(skill: MountedSkill): string {
  const parts = [`### ${skill.name}${skill.summary ? ` — ${skill.summary}` : ''}`, (skill.body ?? '').trim()];
  if (skill.avoid && skill.avoid.length > 0) {
    parts.push('AVOID (banked lessons):', ...skill.avoid.map(a => (a.startsWith('AVOID:') ? a : `AVOID: ${a}`)));
  }
  return parts.join('\n').trim();
}

/**
 * STORY-032.3: compose a system prompt deterministically. Pure — no I/O, no clock,
 * no randomness — so the same inputs always yield the same output. This is what
 * makes the executor and the introspection view provably identical.
 *
 * STORY-UST.1: skills with a `body` additionally get their full procedure injected
 * under `## Skill procedures`, dependency-ordered (caller's order is preserved) and
 * token-budgeted. A body dropped for budget still appears in the bullet index, and the
 * count of dropped procedures is stated (no silent truncation).
 */
export function composeSystemPrompt(
  base: string,
  mountedSkills: MountedSkill[],
  envelopeDocs: string,
  opts: ComposeSystemPromptOptions = {},
): string {
  const parts: string[] = [base.trim()];

  if (mountedSkills.length > 0) {
    // Bullet index — unchanged from 032.3 (a compact list of every mounted skill).
    parts.push(
      '## Mounted skills',
      ...mountedSkills.map(s => `- ${s.name}${s.summary ? `: ${s.summary}` : ''}`),
    );

    // STORY-UST.1: inject the actual procedure bodies, in order, within the budget.
    const budget = opts.skillBodyTokenBudget ?? DEFAULT_SKILL_BODY_TOKEN_BUDGET;
    const withBody = mountedSkills.filter(s => (s.body ?? '').trim().length > 0);
    if (withBody.length > 0) {
      const rendered: string[] = [];
      let used = 0;
      let dropped = 0;
      for (const skill of withBody) {
        const block = renderSkillBody(skill);
        const cost = estimateTokens(block);
        // Always admit the first body (a single skill must never be silently dropped);
        // after that, respect the budget. Dependency order is the caller's order, so
        // prerequisites are admitted before dependents.
        if (rendered.length === 0 || used + cost <= budget) {
          rendered.push(block);
          used += cost;
        } else {
          dropped++;
        }
      }
      parts.push('## Skill procedures', ...rendered);
      if (dropped > 0) {
        parts.push(`(${dropped} skill procedure(s) omitted for token budget; see the bullet index above.)`);
      }
    }
  }

  if (envelopeDocs.trim().length > 0) {
    parts.push('## Envelopes you receive', envelopeDocs.trim());
  }

  return parts.join('\n\n');
}
