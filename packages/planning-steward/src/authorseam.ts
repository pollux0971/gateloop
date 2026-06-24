/**
 * @gateloop/planning-steward — StageDocAuthor seam (STORY-PLLM.3).
 *
 * One interface, TWO implementations:
 *   • SCRIPTED — deterministic, offline, zero-cost. The DEFAULT (tests + CI). Never
 *     touches a key or a network. Builds the document from the skill template +
 *     context (and, on a re-author, patches the failing checklist items).
 *   • REAL — calls the model with the PLLM.2 prompt and drains the streamed text
 *     into the document. It REUSES @gateloop/provider-driver's engine seam
 *     (`LanguageModelEngine`) and reads the key via @gateloop/secret-broker — but it
 *     does so through INJECTION (a `buildEngine` thunk), exactly the way
 *     provider-driver injects the AI SDK rather than importing it. That keeps this
 *     package free of a provider-driver/secret-broker import (no lockfile churn) while
 *     the production wiring (PLLM.4, in apps/api) passes `() => createMeteredEngine(…)`.
 *
 * The key is resolved ONLY inside `buildEngine` (i.e. inside createMeteredEngine's
 * closure); the author never sees it. "set ≠ effective": if the real author is
 * selected but no key is present, `buildEngine` THROWS (createMeteredEngine already
 * throws `no metered key …`) and the author PROPAGATES it loudly — it never silently
 * falls back to the scripted author and fakes success. Design: docs/architecture/28.
 */
import { buildAuthorPrompt } from './authorprompt.js';
import type { DocSkill } from './docskill.js';
import type { ChecklistItem } from './checklist.js';

/** The running context for one authoring attempt (mirrors AuthorPromptInput's context). */
export interface AuthorContext {
  stageId: string;
  idea: string;
  priorDocs?: Record<string, string>;
  /** Present only on a re-author (the author→advance loop, PLLM.4). */
  failingItems?: ChecklistItem[];
}

/** The slice of a skill the author reads (steps + template). */
export type AuthorSkill = Pick<DocSkill, 'steps' | 'template'>;

/** The single seam interface. */
export interface StageDocAuthor {
  readonly kind: 'scripted' | 'real';
  /** idea + skill + prior docs (+ failing items on re-author) → document text. */
  author(skill: AuthorSkill, context: AuthorContext, opts?: { signal?: AbortSignal }): Promise<string>;
}

/** Raised when the author cannot produce a document (e.g. an empty model response). */
export class StageDocAuthorError extends Error {
  constructor(message: string) {
    super(`stage_doc_author: ${message}`);
    this.name = 'StageDocAuthorError';
  }
}

// ───────────────────────── scripted author (default) ─────────────────────────

/**
 * Deterministically strip `<…>` template placeholders by replacing each with its
 * inner text (innermost-first, so nested `<a <b>>` resolves cleanly). A scripted
 * author that emitted raw `<…>` placeholders would be useless AND would fail the
 * completion checker's `no-tbd` directive (which flags `<…>`), so the scripted
 * author fills them. Pure: no clock, no random.
 */
function fillPlaceholders(text: string): string {
  const inner = /<([^<>\n]+)>/g;
  let out = text;
  // Repeat until stable so nested placeholders are fully resolved (bounded loop).
  for (let i = 0; i < 8; i++) {
    const next = out.replace(inner, (_m, body) => String(body));
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Deterministic, offline document builder. No key, no network, no clock, no random:
 * same (skill, context) → byte-identical document. Fills the template's placeholders
 * and incorporates the idea + each step heading; on a re-author it appends a
 * resolution line for every failing item so the output actually changes between
 * attempts (the convergence signal the PLLM.4 loop relies on). The final document is
 * placeholder-free, so a template whose literal structure already satisfies a stage's
 * checklist converges on the first attempt.
 */
export function createScriptedAuthor(): StageDocAuthor {
  return {
    kind: 'scripted',
    async author(skill, context): Promise<string> {
      const lines: string[] = [];
      lines.push(skill.template.trim());
      lines.push('');
      lines.push(`Authored stage: ${context.stageId} (scripted)`);
      lines.push(`Idea: ${context.idea.trim()}`);

      const priors = Object.entries(context.priorDocs ?? {}).filter(
        ([, d]) => typeof d === 'string' && d.trim() !== '',
      );
      for (const [stage] of priors) lines.push(`Based on prior: ${stage}`);

      for (let i = 0; i < (skill.steps ?? []).length; i++) {
        const first = skill.steps[i].content.trim().split('\n')[0];
        lines.push(`Step ${i + 1}: ${first}`);
      }

      const failing = (context.failingItems ?? []).filter((it) => it && it.pass === false);
      for (const it of failing) lines.push(`Resolved: ${it.text.trim()}`);

      // Strip placeholders LAST so nothing the builder appended (or the template
      // carried) leaves a `<…>` behind that would trip the no-tbd checklist item.
      return fillPlaceholders(lines.join('\n')) + '\n';
    },
  };
}

// ─────────────────────────── real author (opt-in) ───────────────────────────

/** A text part from the engine stream — the structural mirror of provider-driver's
 *  neutral `EngineStreamPart` (only the text path is consumed here). */
export type AuthorEnginePart = { type: 'text-delta'; text: string } | { type: string };

/** The structural mirror of provider-driver's `LanguageModelEngine` — what
 *  createMeteredEngine() / createScriptedEngine() return. Declared locally so this
 *  package does not import provider-driver; production injects the real engine. */
export interface AuthorEngine {
  readonly backendId?: string;
  readonly model?: string;
  stream(input: { prompt: string; system?: string; signal?: AbortSignal }): AsyncIterable<AuthorEnginePart>;
}

export interface RealAuthorDeps {
  /**
   * Build the engine for one authoring call. The key is resolved INSIDE this thunk
   * (production: `() => createMeteredEngine({ broker, spec, streamText, modelFactory })`),
   * so the author never sees it. If no key is present this MUST throw (it does —
   * createMeteredEngine throws `no metered key …`); the author propagates that loudly.
   */
  buildEngine(opts: { signal?: AbortSignal }): Promise<AuthorEngine>;
}

/**
 * The real author. Builds the PLLM.2 prompt, obtains an engine via `buildEngine`
 * (where the key lives), drains its text-delta parts into the document, and fails
 * loudly on an empty result. It does NOT catch `buildEngine` errors — a missing key
 * surfaces as a throw, never a silent scripted fallback.
 */
export function createRealAuthor(deps: RealAuthorDeps): StageDocAuthor {
  return {
    kind: 'real',
    async author(skill, context, opts): Promise<string> {
      const { system, prompt } = buildAuthorPrompt({
        stageId: context.stageId,
        idea: context.idea,
        priorDocs: context.priorDocs,
        skill,
        failingItems: context.failingItems,
      });
      // Key resolution happens inside buildEngine (the secret seam). A no-key
      // condition throws here and is intentionally NOT caught.
      const engine = await deps.buildEngine({ signal: opts?.signal });
      let out = '';
      for await (const part of engine.stream({ prompt, system, signal: opts?.signal })) {
        if (part.type === 'text-delta' && typeof (part as { text?: unknown }).text === 'string') {
          out += (part as { text: string }).text;
        }
      }
      if (out.trim() === '') {
        throw new StageDocAuthorError('real author produced an empty document');
      }
      return out;
    },
  };
}

// ─────────────────────────────── selection ───────────────────────────────

export interface AuthorSelect {
  /** DEFAULT 'scripted'. 'real' is opt-in and requires real deps to be wired. */
  mode?: 'scripted' | 'real';
}

export interface SelectAuthorDeps {
  /** Required only when mode==='real' (production wires createMeteredEngine here). */
  real?: RealAuthorDeps;
}

/**
 * Select the author. Scripted-by-default: an absent select, an absent mode, or
 * `mode:'scripted'` all yield the scripted author. `mode:'real'` is opt-in and is the
 * ONLY way to reach the key-consuming path. Selection is explicit configuration — never
 * an agent's choice (mirrors model_routing.selection: config_driven).
 */
export function selectStageDocAuthor(
  select?: AuthorSelect,
  deps: SelectAuthorDeps = {},
): StageDocAuthor {
  const mode = select?.mode ?? 'scripted';
  if (mode === 'real') {
    if (!deps.real) {
      throw new StageDocAuthorError("real author selected but no real deps wired (buildEngine missing)");
    }
    return createRealAuthor(deps.real);
  }
  return createScriptedAuthor();
}
