/**
 * @gateloop/debugger-runtime
 *
 * Deterministic helpers for failure triage + the failure-gene contract. Classification
 * and signature-building are deterministic; root-cause/repair generation is a later phase.
 * Spec: gateloop/docs/agents/04_DEBUGGER_AGENT.md, gateloop/docs/contracts/FAILURE_GENE.md
 *
 * STORY-029.5 wires the Debugger's actual cognition: produceRepairProposal calls
 * the model through agent-core.askModel and returns a minimal, in-scope repair —
 * the debug-side twin of the Developer's producePatchProposal (029.3).
 */
import { askModel, type AskModelDeps } from '@gateloop/agent-core';
import type { AgentStructuredOutput } from '@gateloop/model-gateway';

export type { ImprovementDirection } from '@gateloop/validator-suite';
export type FailureType = 'test' | 'typecheck' | 'lint' | 'runtime' | 'schema' | 'integration';

/** Classify a failure from the failed command + log text. */
export function classifyFailure(failedCommand: string, log: string): FailureType {
  const t = `${failedCommand}\n${log}`.toLowerCase();
  if (/tsc|type error|ts\d{3,}/.test(t)) return 'typecheck';
  if (/eslint|lint/.test(t)) return 'lint';
  if (/schema|invalid json|does not match/.test(t)) return 'schema';
  if (/integration|e2e/.test(t)) return 'integration';
  if (/test|expect|assert|jest|vitest|pytest/.test(t)) return 'test';
  return 'runtime';
}

/** Build a compact, pipe-delimited matching_signal (the dedup/retrieval key). */
export function buildFailureSignature(failureType: FailureType, log: string): string {
  const tokens = (log.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? [])
    .map(s => s.toLowerCase())
    .filter(s => !['error','failed','expected','received','test','the','and'].includes(s));
  const top = Array.from(new Set(tokens)).slice(0, 6);
  return [failureType, ...top].join('|');
}

export type RepairRoute = 'debugger' | 'developer' | 'human';
/** Where a still-failing attempt goes next (see DEBUG_LOOP §). */
export function decideRepairRoute(opts: {
  sameRootCause: boolean; sameSignatureCount: number; debuggerAttempts: number;
  budget: { debugger: number; sameSignature: number };
}): RepairRoute {
  if (opts.sameSignatureCount >= opts.budget.sameSignature || opts.debuggerAttempts >= opts.budget.debugger) return 'human';
  return opts.sameRootCause ? 'debugger' : 'developer';
}

export interface FailureGene {
  id: string; matching_signal: string; summary: string; strategy: string;
  avoid: string; failure_type: FailureType; repair_operator?: string;
  story_id?: string; severity: 'low'|'medium'|'high'; version: number;
  created_at: string; consolidated_count: number; status: 'active'|'resolved'|'quarantined';
}
/** Build a failure gene. `avoid` MUST be ≤40 words (the only injected field). */
export function emitFailureGene(args: {
  matching_signal: string; summary: string; strategy: string; avoid: string;
  failure_type: FailureType; repair_operator?: string; story_id?: string;
  severity?: 'low'|'medium'|'high';
}): FailureGene {
  const words = args.avoid.trim().split(/\s+/);
  if (words.length > 40) throw new Error('failure_gene.avoid must be <= 40 words');
  return {
    id: `fg_${Date.now()}`, matching_signal: args.matching_signal, summary: args.summary,
    strategy: args.strategy, avoid: args.avoid, failure_type: args.failure_type,
    repair_operator: args.repair_operator, story_id: args.story_id,
    severity: args.severity ?? 'medium', version: 1,
    created_at: new Date().toISOString(), consolidated_count: 1, status: 'active'
  };
}

// ── STORY-017.4: Competitive Debug Race ──────────────────────────────────────
import type { ImprovementDirection } from '@gateloop/validator-suite';

/** Locally-typed story record extended with competitive debug fields. Structurally
 *  compatible with StoryRecord from @gateloop/harness-core without the import. */
export interface CompetitiveStoryRecord {
  story_id: string;
  epic_id: string;
  depends_on: string[];
  parallelism_class: 'parallel_safe' | 'parallel_with_barrier' | 'sequential' | 'exclusive';
  status: string;
  attempts: number;
  attempt_budget: number;
  branch: string | null;
  last_action: string | null;
  last_result: string | null;
  last_validation: string | null;
  blocked_reason: string | null;
  competitive_debug?: boolean;
  debug_k?: number;
}

export interface RepairAttempt {
  candidate_id: number;
  passed: boolean;
  failure_gene?: FailureGene;
}

export interface CompetitiveDebugResult {
  winner_candidate: number | null;
  winner_passed: boolean;
  loser_genes: FailureGene[];
  candidates_run: number;
}

export interface CompetitiveDebugOptions {
  story: CompetitiveStoryRecord;
  /** Called once per candidate (0-indexed) with its seeded direction (or null). */
  debugRepair: (candidate: number, direction: ImprovementDirection | null) => Promise<RepairAttempt>;
  /** How many candidates to race. Default: story.debug_k ?? 2. */
  k?: number;
  /** If provided, candidates receive distinct seeded directions. */
  diagnosisDirections?: ImprovementDirection[];
}

/**
 * Assign a distinct direction to each candidate.
 * `widen_write_set` directions are skipped (decision_matrix rule 17 — never auto-seed scope expansion).
 * Wraps around if k > safe directions. Returns null-filled array when no safe directions remain.
 */
export function seedDirections(
  directions: ImprovementDirection[],
  k: number,
): (ImprovementDirection | null)[] {
  const safe = directions.filter(d => d.direction_type !== 'widen_write_set');
  if (safe.length === 0) return Array<ImprovementDirection | null>(k).fill(null);
  return Array.from({ length: k }, (_, i) => safe[i % safe.length]);
}

/** Launch k debug candidates concurrently; select the first passing one as winner.
 *  All candidates run to completion (Promise.all). Loser failure genes are recorded. */
export async function runCompetitiveDebug(opts: CompetitiveDebugOptions): Promise<CompetitiveDebugResult> {
  const k = opts.k ?? opts.story.debug_k ?? 2;
  const seeded = opts.diagnosisDirections
    ? seedDirections(opts.diagnosisDirections, k)
    : Array<ImprovementDirection | null>(k).fill(null);
  const attempts = await Promise.all(
    Array.from({ length: k }, (_, i) => opts.debugRepair(i, seeded[i])),
  );
  const winner = attempts.find(a => a.passed === true);
  const losers = attempts.filter(a => a.passed === false);
  const loser_genes = losers
    .filter(a => a.failure_gene != null)
    .map(a => a.failure_gene!);
  return {
    winner_candidate: winner?.candidate_id ?? null,
    winner_passed: winner != null,
    loser_genes,
    candidates_run: k,
  };
}

// ── STORY-008.4: Debug Loop Wiring ──────────────────────────────────────────
// Wire VALIDATION(fail) → DEBUG_LOOP → VALIDATION.
// All I/O is injected for determinism and testability; no real LLM, no external API.

/** Bank gene shape structurally compatible with @gateloop/failure-bank FailureGene. */
export interface BankGene {
  id: string; matching_signal: string; summary: string; strategy: string;
  avoid: string; failure_type: string; repair_operator: string;
  story_id: string; skill_id: string | null; severity: string;
  version: number; created_at: string; consolidated_count: number;
  resolved_at: string | null; status: string;
}

/** Injected failure-bank operations. Production caller wires @gateloop/failure-bank. */
export interface FailureBankOps {
  bankGene(gene: BankGene): void;
  injectRelevant(context: string, maxK?: number): BankGene[];
  isSystemic(gene: BankGene): boolean;
}

/** Context packet handed to the scripted repair provider. */
export interface DebugContext {
  storyId: string; signature: string; failureType: FailureType;
  failedCommand: string; failedOutput: string;
  relevantWarnings: BankGene[]; allowedWriteSet: string[];
}

/** Minimal shape of an accepted repair proposal output. */
export interface RepairProposalLike {
  kind: 'repair_proposal'; proposal_id: string; story_id: string;
  changed_files: string[]; rollback_notes: string;
  [key: string]: unknown;
}

export interface DebugLoopInput {
  storyId: string;
  /** A verdict that already has `passed: false`. */
  failingVerdict: { passed: false; results: Array<{ command: string; ok: boolean; output: string }> };
  allowedWriteSet: string[];
  maxAttempts: number;
  bankOps: FailureBankOps;
  /** Injected from @gateloop/agent-output validateDebuggerResponse in production. */
  validateDebuggerOutput(o: Record<string, unknown>): { ok: boolean; errors: string[] };
  /** Injected from @gateloop/validator-suite validateWriteSet in production. */
  validateWriteSet(files: string[], writeSet: string[]): { ok: boolean; errors: string[] };
  /** Scripted/fixture repair provider — MUST NOT call a real LLM or external API. */
  repairProvider(ctx: DebugContext): { kind: string; [key: string]: unknown } | null;
  /** Apply a repair proposal and re-run validation; returns whether it passed. */
  applyAndValidate(proposal: RepairProposalLike): { applied: boolean; passed: boolean; error?: string };
  /** Deterministic clock (injected in tests). Falls back to new Date().toISOString(). */
  clock?(): string;
  /** Deterministic ID generator (injected in tests). Falls back to a derived id. */
  idGen?(): string;
}

export type DebugLoopResult =
  | { kind: 'validated'; attempts: number; summary: string }
  | { kind: 'self_correct'; attempts: number; summary: string }
  | { kind: 'escalated'; attempts: number; reason: string };

/**
 * Deterministic debug loop: receives a failing validation verdict, emits and banks a
 * failure gene, asks the scripted repair provider for a proposal, validates write-set
 * and output schema, applies the repair, and re-validates. Exhausting `maxAttempts`
 * or detecting a systemic pattern escalates instead of silently retrying.
 */
export function runDebugLoop(input: DebugLoopInput): DebugLoopResult {
  const {
    storyId, failingVerdict, allowedWriteSet, maxAttempts,
    bankOps, validateDebuggerOutput, validateWriteSet: doValidateWriteSet,
    repairProvider, applyAndValidate, clock, idGen,
  } = input;

  // Step 1 — classify the failure and build a matching_signal
  const firstFailed = failingVerdict.results.find(r => !r.ok);
  const failedCmd = firstFailed?.command ?? '';
  const failedOutput = firstFailed?.output ?? '';
  const failureType = classifyFailure(failedCmd, failedOutput);
  const signature = buildFailureSignature(failureType, failedOutput);

  // Step 2 — construct a bank-compatible failure gene
  const now = clock?.() ?? new Date().toISOString();
  const safeId = storyId.replace(/[^a-z0-9]/gi, '_');
  const geneId = idGen?.() ?? `fg_${safeId}_${failureType}`;
  const avoidText = `Do not repeat ${failureType} failure in: ${failedCmd}`
    .split(/\s+/).slice(0, 10).join(' ');

  const gene: BankGene = {
    id: geneId, matching_signal: signature,
    summary: `${failureType}: ${failedOutput.slice(0, 100)}`,
    strategy: 'apply repair proposal and re-validate',
    avoid: avoidText, failure_type: failureType, repair_operator: 'none',
    story_id: storyId, skill_id: null, severity: 'recoverable', version: 1,
    created_at: now, consolidated_count: 1, resolved_at: null, status: 'active',
  };

  // Step 3 — bank the gene (may be merged with existing entry)
  bankOps.bankGene(gene);

  // Step 4 — systemic pattern check: if the banked signal is recurring, escalate immediately
  if (bankOps.isSystemic(gene)) {
    return { kind: 'escalated', attempts: 0, reason: `systemic failure pattern: ${signature}` };
  }

  // Step 5 — build debug context with relevant prior warnings
  const relevant = bankOps.injectRelevant(`${storyId} ${failedCmd} ${failedOutput}`);
  const ctx: DebugContext = {
    storyId, signature, failureType, failedCommand: failedCmd, failedOutput,
    relevantWarnings: relevant, allowedWriteSet,
  };

  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;

    // Step 6 — ask the scripted repair provider
    const rawOutput = repairProvider(ctx);
    if (!rawOutput) {
      if (attempts >= maxAttempts) return { kind: 'escalated', attempts, reason: 'no repair proposal from provider' };
      return { kind: 'self_correct', attempts, summary: 'no proposal; retry requested' };
    }

    // Step 7 — validate debugger output schema (agent-output gate)
    const outputVal = validateDebuggerOutput(rawOutput as Record<string, unknown>);
    if (!outputVal.ok) {
      if (attempts >= maxAttempts) return { kind: 'escalated', attempts, reason: `invalid debugger output: ${outputVal.errors.join(', ')}` };
      return { kind: 'self_correct', attempts, summary: `invalid output, retry: ${outputVal.errors.join(', ')}` };
    }

    // Step 8 — only repair_proposal kind is actionable
    if (rawOutput.kind !== 'repair_proposal') {
      return { kind: 'escalated', attempts, reason: `debugger output kind=${rawOutput.kind} is not repair_proposal` };
    }

    const proposal = rawOutput as RepairProposalLike;

    // Step 9 — write-set gate: proposal must stay inside allowedWriteSet
    const wsVal = doValidateWriteSet(proposal.changed_files, allowedWriteSet);
    if (!wsVal.ok) {
      return { kind: 'escalated', attempts, reason: `repair out of write-set: ${wsVal.errors.join(', ')}` };
    }

    // Step 10 — apply repair and re-validate
    const applyResult = applyAndValidate(proposal);
    if (applyResult.passed) {
      return { kind: 'validated', attempts, summary: `repair validated after ${attempts} attempt(s)` };
    }

    // Still failing — bank the retry failure before next attempt
    if (attempts < maxAttempts) {
      bankOps.bankGene({
        ...gene, id: `${geneId}_r${attempts}`, consolidated_count: 1,
        created_at: clock?.() ?? new Date().toISOString(),
      });
    }
  }

  return { kind: 'escalated', attempts, reason: `attempt budget exhausted after ${maxAttempts} attempt(s)` };
}

// ── STORY-029.5: Debugger repair via askModel ────────────────────────────────
// The debug-side twin of producePatchProposal (029.3). Given a DebuggerTaskPacket
// (029.4), call the model through agent-core.askModel, parse the response into a
// minimal repair proposal that REUSES the patch_proposal schema shape, and enforce
// the debugger's invariants BEFORE the proposal leaves the agent: stay inside the
// allowed repair scope, respect do-not-touch guardrails, never widen scope, and
// emit a failure gene on the diagnosis (every turn, success or failure).

/** The slice of a Debugger Task Packet that produceRepairProposal reads. */
export interface DebuggerTaskPacketView {
  story_id?: string;
  story_contract_ref?: string;
  contract_version?: number;
  /** LOCAL repair scope (029.4) — the hard bound; nothing may be touched outside it. */
  allowed_repair_scope: string[];
  /** Explicit do-not-touch guardrails; glob-like entries are enforced as path guards. */
  do_not_touch?: string[];
  forbidden_actions?: string[];
  failure_context?: {
    failure_signature?: string;
    failed_command?: string;
    failed_logs_ref?: string;
    changed_files?: string[];
    [k: string]: unknown;
  };
  failure_gene?: { matching_signal: string; avoid: string; consolidated_count?: number } | null;
  acceptance_that_failed?: string[];
  [k: string]: unknown;
}

// ── STORY-030.5: fresh-context debugging ──────────────────────────────────────
// Each debug pass is FRESH: the Debugger sees the broken result + acceptance +
// diff, but NEVER the Developer's reasoning or any prior debug pass's reasoning.
// Author intent contaminates diagnosis the same way it would a Reviewer — the
// anti-anchoring invariant, now applied to the Debugger. The fields it legitimately
// needs (failure_context, failure_gene, acceptance_that_failed) are preserved; only
// generator/prior-debug REASONING is severed.
// Design: docs/agents/07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md.
export const DEBUGGER_FORBIDDEN_CONTEXT_KEYS = [
  'developer_reasoning', 'develop_reasoning', 'agent_reasoning',
  'implementation_history', 'develop_history',
  'prior_debug_reasoning', 'previous_debug_reasoning', 'debug_attempts_reasoning',
] as const;

export interface FreshContextCheck {
  fresh: boolean;
  /** Forbidden reasoning keys present on the packet (empty = fresh). */
  leaked: string[];
}

/**
 * STORY-030.5 tested invariant: a debug pass packet must carry no Developer reasoning
 * and no prior debug pass reasoning. Returns the forbidden keys present.
 */
export function assertDebuggerPacketFresh(packet: Record<string, unknown>): FreshContextCheck {
  const leaked = DEBUGGER_FORBIDDEN_CONTEXT_KEYS.filter(k => packet[k] !== undefined && packet[k] !== null);
  return { fresh: leaked.length === 0, leaked: [...leaked] };
}

/**
 * STORY-030.5: strip any generator / prior-debug reasoning so each debug pass starts
 * fresh. The failure output, acceptance, and diff survive; only reasoning is severed.
 */
export function toFreshDebugPacket<T extends Record<string, unknown>>(packet: T): T {
  const clone: Record<string, unknown> = { ...packet };
  for (const k of DEBUGGER_FORBIDDEN_CONTEXT_KEYS) delete clone[k];
  return clone as T;
}

/** A single repair edit. Repairs are minimal; deleting/weakening tests is forbidden. */
export interface RepairEdit {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  rationale?: string;
}

const REPAIR_CHANGE_TYPES = ['REBIND', 'INSERT_PREREQ', 'SUBSTITUTE', 'REWIRE', 'BYPASS', 'new_impl'] as const;
export type RepairChangeType = (typeof REPAIR_CHANGE_TYPES)[number];

/** Repair proposal, reusing the patch_proposal.schema.json shape (kind=repair_proposal). */
export interface RepairProposal {
  proposal_id: string;
  story_id: string;
  kind: 'repair_proposal';
  contract_id: string;
  contract_version: number;
  summary: string;
  change_type: RepairChangeType;
  changed_files: string[];
  edits: RepairEdit[];
  patch_branch: string;
  postconditions_claimed: string[];
  rollback_notes: string;
  rationale_summary: string;
  additive: boolean;
  reversible: boolean;
  /** The gene emitted on this diagnosis (also returned separately). */
  failure_gene: FailureGene;
  proposed_at: string;
  status: 'proposed';
}

export interface ProduceRepairOptions {
  proposedAt?: string;
  patchBranch?: string;
  /** Deterministic gene id (tests). */
  geneId?: string;
}

export interface ProduceRepairResult {
  ok: boolean;
  proposal?: RepairProposal;
  errors: string[];
  /** Edits outside the allowed repair scope — rejected pre-emit (scope never widened). */
  rejected_paths: string[];
  /** Edits that hit a do-not-touch guardrail (e.g. deleting tests). */
  guardrail_violations: string[];
  /** The failure gene emitted on diagnosis — present even when the repair is rejected. */
  failure_gene?: FailureGene;
  /** When the model escalated instead of proposing a repair, its raw output. */
  escalation?: AgentStructuredOutput;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp('^' + glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
}
function pathsOutside(paths: string[], scope: string[]): string[] {
  return paths.filter(p => !scope.some(g => globToRegExp(g).test(p)));
}
/** A do-not-touch entry is enforceable only if it looks like a path/glob (not prose). */
function globLikeGuards(doNotTouch: string[]): string[] {
  return doNotTouch.filter(g => /[\/*]/.test(g) || /\.\w+$/.test(g));
}
const TEST_FILE = /(^|\/)[^/]*\.test\.[tj]sx?$|(^|\/)tests?\//;

/**
 * Produce a minimal repair proposal for a debugger task packet (STORY-029.5).
 *
 * Calls the model via agent-core.askModel (debugger / debug_repair; scripted in CI,
 * real later), parses the response into a RepairProposal reusing the patch_proposal
 * schema, ALWAYS emits a failure gene on the diagnosis, and enforces three gates
 * before the proposal leaves the agent:
 *   1. malformed model output → rejected by askModel;
 *   2. every edit must stay inside allowed_repair_scope — scope is never widened;
 *   3. do-not-touch guardrails are respected (never delete/weaken tests; never touch
 *      an explicit do_not_touch path).
 * Deterministic given the same packet + provider output (+ injected timestamps).
 */
export async function produceRepairProposal(
  packet: DebuggerTaskPacketView,
  deps: AskModelDeps,
  options: ProduceRepairOptions = {},
): Promise<ProduceRepairResult> {
  const storyId = (packet.story_id as string) ?? 'unknown-story';

  // STORY-030.5: each debug pass is fresh — sever any Developer reasoning and any
  // prior debug pass's reasoning before the packet reaches the model. The failure
  // output, acceptance, and diff (the legitimate fresh context) are preserved.
  const freshPacket = toFreshDebugPacket(packet);

  // Diagnosis: emit a failure gene this turn regardless of outcome.
  const fc = freshPacket.failure_context ?? {};
  const failedCmd = typeof fc.failed_command === 'string' ? fc.failed_command : '';
  const signature = packet.failure_gene?.matching_signal
    ?? (typeof fc.failure_signature === 'string' ? fc.failure_signature : '')
    ?? '';
  const failureType = classifyFailure(failedCmd, signature);
  const avoidText = (packet.failure_gene?.avoid
    ?? `Keep the repair for ${storyId} inside the allowed scope; do not widen or delete tests`)
    .split(/\s+/).slice(0, 40).join(' ');
  const baseGene = emitFailureGene({
    matching_signal: signature || `${failureType}|${storyId}`,
    summary: `repair diagnosis for ${storyId}: ${failedCmd || signature || failureType}`.slice(0, 200),
    strategy: 'minimal in-scope repair; re-validate',
    avoid: avoidText,
    failure_type: failureType,
    story_id: storyId,
  });
  const gene: FailureGene = {
    ...baseGene,
    id: options.geneId ?? `fg_${storyId.replace(/[^a-z0-9]/gi, '_')}_${failureType}`,
    created_at: options.proposedAt ?? baseGene.created_at,
  };

  // 1. Ask the model with the FRESH packet (no generator/prior-debug reasoning).
  // askModel rejects malformed output (ok:false).
  const res = await askModel(
    { role: 'debugger', taskClass: 'debug_repair', taskPacket: freshPacket as Record<string, unknown>, storyId },
    deps,
  );
  if (!res.ok || !res.output) {
    return {
      ok: false,
      errors: res.errors.length ? res.errors : ['model returned no usable output'],
      rejected_paths: [], guardrail_violations: [], failure_gene: gene,
    };
  }

  // 2. The debugger must return a repair_proposal; anything else is an escalation.
  const out = res.output as { kind?: string } & Record<string, unknown>;
  if (out.kind !== 'repair_proposal') {
    return {
      ok: false,
      errors: [`debugger did not produce a repair (kind=${out.kind ?? 'none'}); escalation surfaced`],
      rejected_paths: [], guardrail_violations: [], failure_gene: gene, escalation: res.output,
    };
  }

  // 3. Normalize.
  const changedFiles = Array.isArray(out.changed_files) ? (out.changed_files as string[]) : [];
  const edits: RepairEdit[] = Array.isArray(out.edits)
    ? (out.edits as RepairEdit[])
    : changedFiles.map(p => ({ path: p, operation: 'modify' as const }));
  const rollbackNotes = typeof out.rollback_notes === 'string' ? out.rollback_notes : '';
  const rationale = typeof out.rationale_summary === 'string'
    ? out.rationale_summary
    : (typeof out.summary === 'string' ? out.summary : '');

  if (changedFiles.length === 0) {
    return { ok: false, errors: ['repair has no changed_files'], rejected_paths: [], guardrail_violations: [], failure_gene: gene };
  }

  const allPaths = [...new Set([...changedFiles, ...edits.map(e => e.path)])];

  // 4. Scope gate — never widen beyond allowed_repair_scope.
  const outside = pathsOutside(allPaths, packet.allowed_repair_scope);
  if (outside.length > 0) {
    return {
      ok: false,
      errors: [`repair widens scope beyond allowed_repair_scope: ${outside.join(', ')}`],
      rejected_paths: outside, guardrail_violations: [], failure_gene: gene,
    };
  }

  // 5. Do-not-touch guardrails: never delete/weaken tests; never touch a guarded path.
  const violations: string[] = [];
  for (const e of edits) {
    if (e.operation === 'delete' && TEST_FILE.test(e.path)) violations.push(`must not delete test file: ${e.path}`);
  }
  const guards = globLikeGuards(packet.do_not_touch ?? []);
  for (const p of allPaths) {
    if (guards.some(g => globToRegExp(g).test(p))) violations.push(`touches do-not-touch path: ${p}`);
  }
  if (violations.length > 0) {
    return { ok: false, errors: ['repair violates do-not-touch guardrails', ...violations], rejected_paths: [], guardrail_violations: violations, failure_gene: gene };
  }

  // 6. Reversible (rollback notes) — a repair must be revertable.
  if (rollbackNotes.trim().length === 0) {
    return { ok: false, errors: ['repair is not reversible: missing rollback_notes'], rejected_paths: [], guardrail_violations: [], failure_gene: gene };
  }

  const changeTypeRaw = typeof out.change_type === 'string' ? out.change_type : 'REBIND';
  const change_type: RepairChangeType = (REPAIR_CHANGE_TYPES as readonly string[]).includes(changeTypeRaw)
    ? (changeTypeRaw as RepairChangeType) : 'REBIND';
  const destructive = edits.some(e => e.operation === 'delete');

  const proposal: RepairProposal = {
    proposal_id: typeof out.proposal_id === 'string' ? out.proposal_id : `RP-${storyId}-001`,
    story_id: storyId,
    kind: 'repair_proposal',
    contract_id: packet.story_contract_ref ?? `story_contract:${storyId}`,
    contract_version: typeof packet.contract_version === 'number' ? packet.contract_version : 1,
    summary: (typeof out.summary === 'string' ? out.summary : rationale || `Repair for ${storyId}`).slice(0, 300),
    change_type,
    changed_files: changedFiles,
    edits,
    patch_branch: options.patchBranch ?? `story/${storyId}`,
    postconditions_claimed: Array.isArray(out.postconditions_claimed)
      ? (out.postconditions_claimed as string[])
      : (packet.acceptance_that_failed ?? []),
    rollback_notes: rollbackNotes,
    rationale_summary: rationale || `Minimal in-scope repair for ${storyId}.`,
    additive: !destructive,
    reversible: true,
    failure_gene: gene,
    proposed_at: options.proposedAt ?? new Date().toISOString(),
    status: 'proposed',
  };
  return { ok: true, proposal, errors: [], rejected_paths: [], guardrail_violations: [], failure_gene: gene };
}
