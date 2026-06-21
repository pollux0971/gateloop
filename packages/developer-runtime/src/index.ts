/**
 * @gateloop/developer-runtime
 *
 * The Developer agent's runtime: define the output contract, validate a returned
 * patch proposal, and (STORY-029.3) actually PRODUCE one by calling the model
 * through agent-core.askModel. Code generation is no longer a stub — the single
 * most critical joint in the system. Safe by construction: an edit outside the
 * write-set is rejected before it ever leaves the agent.
 * Spec: gateloop/docs/agents/03_DEVELOPER_AGENT.md
 */
import { askModel, type AskModelDeps, type MountedSkill } from '@gateloop/agent-core';
import { loadMountedSkillsForRole } from '@gateloop/skill-runtime';
import type { AgentStructuredOutput } from '@gateloop/model-gateway';
import { fileURLToPath } from 'node:url';

export interface ValidationResult { ok: boolean; errors: string[] }

/** Every Developer turn must return exactly these artifacts. */
export const DEVELOPER_OUTPUT_CONTRACT = [
  'implementation_plan','patch_proposal','changed_files','test_plan','risk_notes','rollback_notes'
] as const;

export function validateDeveloperOutput(out: Record<string, unknown>): ValidationResult {
  const errors = DEVELOPER_OUTPUT_CONTRACT.filter(k => out[k] === undefined || out[k] === null)
    .map(k => `missing developer output: ${k}`);
  return { ok: errors.length === 0, errors };
}

/** changed_files must be ⊆ allowed_write_set (glob). Pre-apply check mirror. */
export function changedFilesWithinWriteSet(changedFiles: string[], allowedWriteSet: string[]): ValidationResult {
  const match = (p: string) => allowedWriteSet.some(g => new RegExp('^' +
    g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*/g,'§').replace(/\*/g,'[^/]*').replace(/§/g,'.*') + '$').test(p));
  const errors = changedFiles.filter(f => !match(f)).map(f => `outside write-set: ${f}`);
  return { ok: errors.length === 0, errors };
}

// ── Patch proposal production (STORY-029.3 — the critical joint) ─────────────

/**
 * STORY-030.2: an acceptance test handed to the Developer. The Developer may
 * READ these (they tell it the bar to clear) but may never author or modify
 * them — that authority belongs to the Assessor (STORY-030.3) / Planning. The
 * generator no longer defines its own bar.
 */
export interface AcceptanceTestRef {
  /** Path of the acceptance-test file (the Developer's write-set must exclude it). */
  path: string;
  /** Optional inline content so the Developer can read the bar without write access. */
  content?: string;
  /** Who authored the acceptance test — never the developer/debugger. */
  source: 'assessor' | 'planning';
}

/** The slice of a Developer Task Packet that producePatchProposal reads. */
export interface DeveloperTaskPacketView {
  story_id?: string;
  story_contract_ref?: string;
  contract_version?: number;
  allowed_write_set: string[];
  acceptance_criteria?: string[];
  /** STORY-030.2: acceptance tests provided to the Developer (read-only). */
  acceptance_tests?: AcceptanceTestRef[];
  /** STORY-030.2: extra acceptance-test paths the Developer must not write. */
  acceptance_test_paths?: string[];
  /** §1b: current content of files in scope, so a modify that strips existing
   *  exported behavior can be detected before the proposal leaves the agent. */
  current_files?: Record<string, string>;
  [k: string]: unknown;
}

/** Glob match (same semantics as the write-set check): ** = any, * = non-slash. */
function globMatch(p: string, glob: string): boolean {
  return new RegExp('^' +
    glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$'
  ).test(p);
}

/**
 * STORY-030.2: the set of paths the Developer is forbidden to author — its own
 * acceptance tests. Union of the explicit acceptance_test_paths and the paths of
 * every acceptance_tests entry in the packet. Deduped.
 */
export function acceptanceTestPathsFromPacket(packet: DeveloperTaskPacketView): string[] {
  return dedupe([
    ...(packet.acceptance_test_paths ?? []),
    ...((packet.acceptance_tests ?? []).map(t => t.path)),
  ]);
}

/** STORY-030.2: acceptance tests the Developer is allowed to READ (never write). */
export function developerReadableTests(packet: DeveloperTaskPacketView): AcceptanceTestRef[] {
  return packet.acceptance_tests ?? [];
}

/**
 * STORY-030.2: reject any changed file that is one of the Developer's own
 * acceptance tests. Returns the violating paths. The generator may read these
 * (they are in the packet) but writing them is a hard boundary violation.
 */
export function rejectDeveloperAuthoredAcceptanceTests(
  changedFiles: string[],
  acceptanceTestPaths: string[],
): ValidationResult {
  const violations = changedFiles.filter(f => acceptanceTestPaths.some(g => globMatch(f, g) || f === g));
  return {
    ok: violations.length === 0,
    errors: violations.map(f => `developer_cannot_author_own_acceptance_tests: ${f}`),
  };
}

/** A single file edit. Additive-first: create/modify are additive; delete is destructive.
 *  A `modify` is only additive if it does not REMOVE existing behavior (plan §1b / §C-3). */
export interface ProposedEdit {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  rationale?: string;
  /** Full new file content (for create/modify). Needed to detect a modify that strips
   *  existing behavior — the gap the operation==='delete' check alone misses. */
  content?: string;
}

// ── §1b: non-additive `modify` detection (fixes the §C-3 gate hole) ──────────
// The additive gate used to flag only operation==='delete'. A `modify` that drops
// an earlier story's exported behavior (e.g. deletes the lines defining an exported
// function) is NOT a delete, so it sailed through every static gate and shipped —
// the deepseek S2-deletion root cause. This detects existing exported symbols that
// a modify removes, so "delete behavior by rewriting the file" is caught pre-emit.

/** Exported top-level symbol names declared in a source file. */
function exportedSymbols(src: string): Set<string> {
  const out = new Set<string>();
  const re = /export\s+(?:async\s+)?(?:function|const|class|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  // also `export { a, b }` re-export lists
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(src)) !== null) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.add(name);
    }
  }
  return out;
}

/**
 * §1b: exported behavior that a `modify` REMOVES — symbols present in the old file
 * but gone from the new content. A non-empty result is a non-additive modify that
 * the additive gate must reject (preserving existing behavior unless the story says
 * otherwise). Returns the removed export names (formatted), empty when none removed.
 */
export function removedExistingBehavior(oldContent: string, newContent: string): string[] {
  const oldSyms = exportedSymbols(oldContent);
  const newSyms = exportedSymbols(newContent);
  return [...oldSyms].filter(s => !newSyms.has(s)).map(s => `export ${s}`);
}

// ── §1c: the Developer system prompt (the work rules that never reached the model) ──
// The inventory found the Developer's askModel call passed NO prompt, so the working
// rules in docs/agents/03_DEVELOPER_AGENT.md (localize, additive-first, preserve
// existing behavior, honor genes, pre-submit self-check) were never sent. This base
// is now composed and sent on every Developer turn.

/** The Developer's base system prompt — its working rules, sent on every turn (§1c). */
export function developerSystemPromptBase(): string {
  return [
    'You are the Developer. Produce a single minimal, additive, reversible patch within the allowed write-set, plus initial tests.',
    'Working rules:',
    '1. Localize first — touch the smallest set of files; never write outside the write-set. If you need to, stop and report (do not self-widen).',
    '2. Additive-first — prefer adding over rewriting; the smallest change that satisfies the acceptance criteria.',
    '3. PRESERVE EXISTING BEHAVIOR — when you modify a shared file, keep every existing exported function and behavior intact. Additive at the LINE level: do not delete or weaken existing lines/behavior unless this story explicitly requires it. Removing existing behavior via a `modify` is a violation, not just a `delete`.',
    '4. One concern per patch — do not bundle unrelated changes.',
    '5. Reversible — provide rollback notes; keep all work in the workspace branch.',
    '6. Honor failure genes — if AVOID warnings are injected, follow them.',
    '7. You do not author your own acceptance tests, apply your own patch, merge, promote, read secrets, or mark the story done.',
    'When blocked or unsure, emit a structured escalation instead of guessing.',
  ].join('\n');
}

const CHANGE_TYPES = ['REBIND', 'INSERT_PREREQ', 'SUBSTITUTE', 'REWIRE', 'BYPASS', 'new_impl'] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** Structured patch proposal, conforming to specs/patch_proposal.schema.json (plus
 *  the additive/reversible/edit detail the harness needs to apply it safely). */
export interface PatchProposal {
  proposal_id: string;
  story_id: string;
  contract_id: string;
  contract_version: number;
  summary: string;
  change_type: ChangeType;
  changed_files: string[];
  patch_branch: string;
  patch_diff_path?: string;
  postconditions_claimed: string[];
  validation_commands_run?: string[];
  proposed_at: string;
  status: 'proposed';
  edits: ProposedEdit[];
  rationale_summary: string;
  rollback_notes: string;
  additive: boolean;
  reversible: boolean;
}

export interface ProducePatchProposalOptions {
  /** Injected timestamp for a deterministic proposed_at; defaults to now(). */
  proposedAt?: string;
  /** Patch branch; defaults to story/<story_id>. Never the main branch. */
  patchBranch?: string;
  /**
   * STORY-UST.1: explicit mounted skills (with SKILL.md body) to inject into the
   * Developer's system prompt. When omitted, the registered developer skills are
   * loaded from `skillsRoot` (or the repo skills dir) — so a registered skill's
   * procedure actually reaches the model, not just a name bullet. Pass `[]` to mount
   * nothing (deterministic tests).
   */
  mountedSkills?: MountedSkill[];
  /** STORY-UST.1: repo root holding skills/skill_manifest.json; defaults to gateloop/. */
  skillsRoot?: string;
}

/** STORY-UST.1: the gateloop/ repo root, where skills/skill_manifest.json lives. */
function defaultSkillsRepoRoot(): string {
  return fileURLToPath(new URL('../../../', import.meta.url)); // packages/developer-runtime/(src|dist) → gateloop/
}

/**
 * STORY-UST.1: resolve the developer skills to mount, body included. Explicit
 * `mountedSkills` win; otherwise load registered developer skills (dependency-ordered,
 * frontmatter-stripped) from the catalog. Fail-soft: any read error → no skills mounted,
 * never a thrown error (a missing catalog must not break patch generation).
 */
function resolveDeveloperMountedSkills(options: ProducePatchProposalOptions): MountedSkill[] {
  if (options.mountedSkills) return options.mountedSkills;
  try {
    const root = options.skillsRoot ?? defaultSkillsRepoRoot();
    return loadMountedSkillsForRole('developer', root).map(s => ({
      name: s.name, summary: s.summary, body: s.body, avoid: s.avoid,
    }));
  } catch {
    return [];
  }
}

export interface ProducePatchProposalResult {
  ok: boolean;
  proposal?: PatchProposal;
  errors: string[];
  /** Paths the model tried to touch outside the write-set — rejected before emit. */
  rejected_paths: string[];
  /** When the model escalated instead of proposing, its raw structured output. */
  escalation?: AgentStructuredOutput;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Produce a patch proposal for a developer task packet (STORY-029.3).
 *
 * Calls the model via agent-core.askModel (config-driven provider; scripted in CI,
 * real later — same interface), parses the response into a structured, schema-
 * conforming PatchProposal, and enforces three safety gates BEFORE the proposal
 * leaves the agent:
 *   1. malformed model output → already rejected inside askModel (ok:false);
 *   2. any edit outside the packet's allowed_write_set → rejected pre-emit;
 *   3. the proposal must be additive (no deletes) and reversible (rollback notes).
 * A self-described rationale summary is attached. Deterministic given the same
 * packet + provider output (+ injected proposed_at).
 */
export async function producePatchProposal(
  packet: DeveloperTaskPacketView,
  deps: AskModelDeps,
  options: ProducePatchProposalOptions = {},
): Promise<ProducePatchProposalResult> {
  const storyId = (packet.story_id as string) ?? 'unknown-story';

  // 1. Ask the model. askModel applies the same malformed-output rejection as fixtures.
  //    §1c: send the Developer's working rules as a composed system prompt — previously
  //    this call passed NO prompt, so the rules in 03_DEVELOPER_AGENT.md never reached
  //    the model. composeSystemPrompt (via askModel) now folds them in on every turn.
  // STORY-UST.1: mount registered developer skills WITH their SKILL.md body, so the
  // skill procedure (e.g. ponytail's lazy ladder) actually reaches the model — not just
  // a one-line bullet. composeSystemPrompt (inside askModel) injects the bodies.
  const mountedSkills = resolveDeveloperMountedSkills(options);
  const res = await askModel(
    {
      role: 'developer', taskClass: 'patch_generation', taskPacket: packet as Record<string, unknown>, storyId,
      prompt: { base: developerSystemPromptBase(), mountedSkills },
    },
    deps,
  );
  if (!res.ok || !res.output) {
    return {
      ok: false,
      errors: res.errors.length ? res.errors : ['model returned no usable output'],
      rejected_paths: [],
    };
  }

  // 2. The developer must return a patch_proposal; any other kind is an escalation.
  const out = res.output as { kind?: string } & Record<string, unknown>;
  if (out.kind !== 'patch_proposal') {
    return {
      ok: false,
      errors: [`developer did not produce a patch (kind=${out.kind ?? 'none'}); escalation surfaced`],
      rejected_paths: [],
      escalation: res.output,
    };
  }

  // 3. Normalize the raw output into proposal fields.
  const changedFiles = Array.isArray(out.changed_files) ? (out.changed_files as string[]) : [];
  const edits: ProposedEdit[] = Array.isArray(out.edits)
    ? (out.edits as ProposedEdit[])
    : changedFiles.map((p) => ({ path: p, operation: 'modify' as const }));
  const rollbackNotes = typeof out.rollback_notes === 'string' ? out.rollback_notes : '';
  const rationale = typeof out.rationale_summary === 'string'
    ? out.rationale_summary
    : (typeof out.summary === 'string' ? out.summary : '');

  if (changedFiles.length === 0) {
    return { ok: false, errors: ['proposal has no changed_files'], rejected_paths: [] };
  }

  // 4. PRE-EMIT write-set gate: an edit outside the write-set never leaves the agent.
  const allPaths = dedupe([...changedFiles, ...edits.map((e) => e.path)]);
  const within = changedFilesWithinWriteSet(allPaths, packet.allowed_write_set);
  if (!within.ok) {
    const rejected = allPaths.filter((p) => !changedFilesWithinWriteSet([p], packet.allowed_write_set).ok);
    return {
      ok: false,
      errors: ['edits outside write-set rejected before emit', ...within.errors],
      rejected_paths: rejected,
    };
  }

  // 4b. STORY-030.2: acceptance-test authorship gate. The Developer may READ its
  // acceptance tests (they are in the packet) but never AUTHOR or modify them —
  // a patch that touches its own acceptance tests is rejected before it emits.
  const forbiddenTestPaths = acceptanceTestPathsFromPacket(packet);
  const testGate = rejectDeveloperAuthoredAcceptanceTests(allPaths, forbiddenTestPaths);
  if (!testGate.ok) {
    const rejected = allPaths.filter((p) =>
      forbiddenTestPaths.some((g) => globMatch(p, g) || p === g));
    return {
      ok: false,
      errors: ['developer may not author its own acceptance tests', ...testGate.errors],
      rejected_paths: rejected,
    };
  }

  // 5. Additive + reversible gates.
  const destructive = edits.filter((e) => e.operation === 'delete').map((e) => e.path);

  // §1b (§C-3 fix): a `modify` that REMOVES existing exported behavior is non-additive
  // even though it is not an operation==='delete'. Compare each modify's new content
  // against the current file; any exported symbol that disappears is a violation.
  const currentFiles = (packet.current_files ?? {}) as Record<string, string>;
  const behaviorRemovals: string[] = [];
  for (const e of edits) {
    if (e.operation === 'delete') continue; // already covered by the delete check
    const old = currentFiles[e.path];
    if (old === undefined || typeof e.content !== 'string') continue; // new file / no content to compare
    const removed = removedExistingBehavior(old, e.content);
    if (removed.length) behaviorRemovals.push(`${e.path} removes existing ${removed.join(', ')}`);
  }

  const additive = destructive.length === 0 && behaviorRemovals.length === 0;
  const reversible = rollbackNotes.trim().length > 0;
  const gateErrors: string[] = [];
  if (destructive.length) gateErrors.push(`proposal is not additive: deletes ${destructive.join(', ')}`);
  if (behaviorRemovals.length) gateErrors.push(`proposal is not additive: modify removes existing behavior — ${behaviorRemovals.join('; ')}`);
  if (!reversible) gateErrors.push('proposal is not reversible: missing rollback_notes');
  if (gateErrors.length) return { ok: false, errors: gateErrors, rejected_paths: [] };

  const changeTypeRaw = typeof out.change_type === 'string' ? out.change_type : 'new_impl';
  const change_type: ChangeType = (CHANGE_TYPES as readonly string[]).includes(changeTypeRaw)
    ? (changeTypeRaw as ChangeType)
    : 'new_impl';

  const proposal: PatchProposal = {
    proposal_id: typeof out.proposal_id === 'string' ? out.proposal_id : `PP-${storyId}-001`,
    story_id: storyId,
    contract_id: packet.story_contract_ref ?? `story_contract:${storyId}`,
    contract_version: typeof packet.contract_version === 'number' ? packet.contract_version : 1,
    summary: (typeof out.summary === 'string' ? out.summary : rationale || `Patch for ${storyId}`).slice(0, 300),
    change_type,
    changed_files: changedFiles,
    patch_branch: options.patchBranch ?? `story/${storyId}`,
    postconditions_claimed: Array.isArray(out.postconditions_claimed)
      ? (out.postconditions_claimed as string[])
      : (packet.acceptance_criteria ?? []),
    proposed_at: options.proposedAt ?? new Date().toISOString(),
    status: 'proposed',
    edits,
    rationale_summary: rationale || `Implements ${storyId} within the allowed write-set.`,
    rollback_notes: rollbackNotes,
    additive,
    reversible,
  };
  return { ok: true, proposal, errors: [], rejected_paths: [] };
}

// ── Pre-submit Observe loop (the ReAct Observe step the Developer lacked) ─────
//
// Before this, the Developer was single-shot: one askModel → three STATIC gates
// (write-set, acceptance-test authorship, additive=no-delete + has-rollback) →
// emit. None of those gates apply the patch or run a single test, so a `modify`
// that strips an earlier story's in-file behaviour passed every gate and shipped
// (the S2-deletion failure). The missing step is OBSERVE: apply the patch, run the
// affected tests, look at the result, and self-correct on red.
//
// This loop is the Observe. It is harness-orchestrated (the model call inside each
// round is still single-shot — same as runDebugLoop): produce → observe → if red,
// feed the red tests back and produce again → bounded self-correction. A proposal
// can only reach `submit` AFTER a preflight that passed, so emitting without having
// observed is structurally impossible (and additionally guarded by
// assertDeveloperObservedBeforeEmit). CI-safe: both collaborators are injected.

/** The Observe outcome the loop reads. Structurally compatible with
 *  PreflightExecReport from @gateloop/preflight-runner (executePreflight) — only the
 *  fields the loop needs are required, keeping developer-runtime decoupled. */
export interface PreflightObservation {
  passed: boolean;
  /** Tests that went red applying this patch — fed back for self-correction. */
  failing_tests: string[];
  /** Proof the observation was a real apply-and-run, not a map read. */
  executed: true;
  verdict?: 'submit' | 'self_correct' | 'escalate';
  typecheck_ok?: boolean;
}

/** Feedback handed to the developer provider for a self-correction round. */
export interface ObserveFeedback {
  /** The self-correction round number (1 = first correction after the initial red). */
  attempt: number;
  /** The tests that were red in the previous round. */
  failing_tests: string[];
  /** Whether typecheck was clean in the previous round. */
  typecheck_ok: boolean;
}

/** Injected collaborators for the Observe loop (both CI-safe / scripted in fixtures). */
export interface DeveloperObserveDeps {
  /** Produce a patch proposal. `feedback` is null on the first turn, then carries the
   *  prior round's red tests so the developer can self-correct. Scripted in CI. */
  developerProvider(feedback: ObserveFeedback | null): Promise<ProducePatchProposalResult> | ProducePatchProposalResult;
  /** Observe a proposal: apply it to a disposable workspace and run the affected
   *  tests for real, returning the result. Wraps executePreflight in production. */
  observe(proposal: PatchProposal): Promise<PreflightObservation> | PreflightObservation;
  /** Max self-corrections after the initial red (03_DEVELOPER_AGENT.md ⇒ 2). */
  maxSelfCorrections?: number;
  /** Optional trace sink — one event per round (the preflight result + attempt). */
  trace?(event: {
    type: 'developer_preflight';
    attempt: number;
    passed: boolean;
    failing_tests: string[];
    verdict: 'submit' | 'self_correct' | 'escalate';
  }): void;
}

export type DeveloperObserveResult =
  | { kind: 'submit'; proposal: PatchProposal; attempts: number; observed: true }
  | { kind: 'escalated'; attempts: number; reason: string; observed: boolean };

/**
 * Run the Developer's pre-submit Observe loop with bounded self-correction.
 *
 *   produce → OBSERVE (apply + run affected tests) →
 *     green ⇒ submit (only path to emit; always observed)
 *     red & budget left ⇒ feed the red tests back, produce a corrected patch, re-observe
 *     red & budget exhausted (or recurring signature) ⇒ escalate, never loop
 *
 * Mirrors runDebugLoop's injection model. Deterministic given the same provider
 * outputs and observations; no LLM and no network are required to test it.
 */
export async function runDeveloperObserveLoop(
  deps: DeveloperObserveDeps,
): Promise<DeveloperObserveResult> {
  const maxSelfCorrections = deps.maxSelfCorrections ?? 2;
  let attempts = 0; // number of self-corrections performed so far
  let feedback: ObserveFeedback | null = null;

  let prod = await deps.developerProvider(feedback);
  if (!prod.ok || !prod.proposal) {
    return { kind: 'escalated', attempts, reason: 'developer produced no proposal to observe', observed: false };
  }

  // Loop invariant: `prod.proposal` is the current candidate; it is OBSERVED before
  // it can ever be submitted.
  for (;;) {
    const report = await deps.observe(prod.proposal);
    const verdict: 'submit' | 'self_correct' | 'escalate' = report.passed
      ? 'submit'
      : attempts >= maxSelfCorrections
        ? 'escalate'
        : 'self_correct';

    deps.trace?.({
      type: 'developer_preflight',
      attempt: attempts,
      passed: report.passed,
      failing_tests: report.failing_tests,
      verdict,
    });

    if (report.passed) {
      // Only exit to emit — and only after a real observation passed.
      return { kind: 'submit', proposal: prod.proposal, attempts, observed: true };
    }

    if (attempts >= maxSelfCorrections) {
      return {
        kind: 'escalated',
        attempts,
        reason: `preflight still red after ${attempts} self-correction(s): ${report.failing_tests.join(', ') || 'unknown failure'}`,
        observed: true,
      };
    }

    // Self-correct: feed the red tests back and ask for a corrected patch.
    attempts++;
    feedback = {
      attempt: attempts,
      failing_tests: report.failing_tests,
      typecheck_ok: report.typecheck_ok ?? true,
    };
    prod = await deps.developerProvider(feedback);
    if (!prod.ok || !prod.proposal) {
      return { kind: 'escalated', attempts, reason: 'developer produced no corrected proposal', observed: true };
    }
  }
}

/**
 * Tested invariant: a Developer proposal may not reach emit without having been
 * OBSERVED (a real preflight run) that PASSED. Any emit path must call this; it
 * makes "ship without running the tests" — the S2-deletion failure mode — throw
 * rather than silently proceed.
 */
export function assertDeveloperObservedBeforeEmit(ctx: {
  proposalId: string;
  preflight?: { executed?: boolean; passed?: boolean } | null;
}): void {
  if (!ctx.preflight || ctx.preflight.executed !== true) {
    throw new Error(`developer_emit_without_observe: proposal ${ctx.proposalId} reached emit with no real preflight run`);
  }
  if (ctx.preflight.passed !== true) {
    throw new Error(`developer_emit_with_failed_preflight: proposal ${ctx.proposalId} preflight did not pass`);
  }
}
