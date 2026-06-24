/**
 * @gateloop/planning-steward — Author-prompt builder (STORY-PLLM.2).
 *
 * The deterministic, OFFLINE core of EPIC-PLLM's authoring wire. Given a loaded
 * doc-skill (steps + template, from docskill.ts) and the running context (idea +
 * optional prior-stage documents + optional failing checklist items to fix), it
 * assembles the authoring prompt as a PURE FUNCTION — no provider call, no network,
 * no key, no clock, no randomness. Same inputs → byte-identical prompt.
 *
 * This is the single place prompt wording lives, so the scripted author (default,
 * CI) and the real author (opt-in, PLLM.3) drive off the same contract. Design:
 * docs/architecture/28_PLANNING_LLM_AUTHORING.md §1.
 *
 * The checklist is deliberately NOT an input (author ≠ grader — preserves the
 * PSKILL separation); only a BLOCKED advance's `failingItems` are fed back, as an
 * explicit "## Fix these issues" block, so the author is told exactly what to
 * repair without ever seeing the answer key.
 */
import type { DocSkill } from './docskill.js';
import type { ChecklistItem } from './checklist.js';

/** Context handed to the builder for one authoring attempt. */
export interface AuthorPromptInput {
  /** Which stage is being authored: 'prd' | 'architecture' | 'epics' (etc.). */
  stageId: string;
  /** The operator's one-paragraph brief / idea. */
  idea: string;
  /**
   * Documents authored by earlier stages, e.g. { prd: '…' } when authoring
   * `architecture`. Iterated in INSERTION ORDER (callers supply pipeline order:
   * brief→prd→architecture→epics), so the prompt is deterministic for a given
   * input. Omitted/empty → no "Prior documents" section (the first stage).
   */
  priorDocs?: Record<string, string>;
  /** The loaded skill — only its steps + template are read here. */
  skill: Pick<DocSkill, 'steps' | 'template'>;
  /**
   * Present ONLY on a re-author (the author→advance loop, PLLM.4): the checklist
   * items the previous advance rejected. Rendered as a "Fix these issues" block.
   */
  failingItems?: ChecklistItem[];
}

/** The assembled prompt — maps 1:1 onto EngineRunInput {system, prompt}. */
export interface AuthorPrompt {
  system: string;
  prompt: string;
}

/**
 * Compose the authoring prompt. Pure + deterministic: no I/O, no Date, no random.
 * Section order is fixed (Idea → Prior documents? → Authoring steps → Template →
 * Fix these issues?) so the output is stable for a given input.
 */
export function buildAuthorPrompt(input: AuthorPromptInput): AuthorPrompt {
  const stageId = input.stageId.trim();

  const system = [
    `You are the GateLoop Planning Steward authoring the "${stageId}" document.`,
    `Follow the authoring steps in order and fill the template completely.`,
    `Output ONLY the document body in Markdown — no preamble, no commentary, no code fences.`,
  ].join(' ');

  const sections: string[] = [];

  // 1. Idea — always present.
  sections.push(`## Idea\n${input.idea.trim()}`);

  // 2. Prior documents — only when earlier stages produced output (insertion order).
  const priorEntries = Object.entries(input.priorDocs ?? {}).filter(
    ([, doc]) => typeof doc === 'string' && doc.trim() !== '',
  );
  if (priorEntries.length > 0) {
    const body = priorEntries
      .map(([stage, doc]) => `### ${stage}\n${doc.trim()}`)
      .join('\n\n');
    sections.push(`## Prior documents\n${body}`);
  }

  // 3. Authoring steps — the skill's ordered step files, numbered. Always present
  //    (an empty steps[] yields the header + "(none)" so the contract is explicit).
  const steps = input.skill.steps ?? [];
  const stepsBody =
    steps.length > 0
      ? steps.map((s, i) => `${i + 1}. ${s.content.trim()}`).join('\n')
      : '(none)';
  sections.push(`## Authoring steps\n${stepsBody}`);

  // 4. Template to fill — always present.
  sections.push(`## Template to fill\n${input.skill.template.trim()}`);

  // 5. Fix these issues — only on a re-author with failing items.
  const failing = (input.failingItems ?? []).filter((it) => it && it.pass === false);
  if (failing.length > 0) {
    const body = failing.map((it) => `- ${it.text.trim()}`).join('\n');
    sections.push(`## Fix these issues\n${body}`);
  }

  return { system, prompt: sections.join('\n\n') };
}
