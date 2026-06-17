/**
 * @gateloop/agent-core — composeSystemPrompt (STORY-032.3)
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
 */

export interface MountedSkill {
  name: string;
  /** Optional one-line summary shown in the composed prompt. */
  summary?: string;
}

/**
 * STORY-032.3: compose a system prompt deterministically. Pure — no I/O, no clock,
 * no randomness — so the same inputs always yield the same output. This is what
 * makes the executor and the introspection view provably identical.
 */
export function composeSystemPrompt(
  base: string,
  mountedSkills: MountedSkill[],
  envelopeDocs: string,
): string {
  const parts: string[] = [base.trim()];

  if (mountedSkills.length > 0) {
    parts.push(
      '## Mounted skills',
      ...mountedSkills.map(s => `- ${s.name}${s.summary ? `: ${s.summary}` : ''}`),
    );
  }

  if (envelopeDocs.trim().length > 0) {
    parts.push('## Envelopes you receive', envelopeDocs.trim());
  }

  return parts.join('\n\n');
}
