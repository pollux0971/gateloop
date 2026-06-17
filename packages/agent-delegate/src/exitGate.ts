/**
 * @gateloop/agent-delegate — Exit gate (STORY-033.6) — THE SECURITY CRUX
 *
 * "Gate-out" of the (B) model. The sandbox ran autonomously; nothing it produced is
 * trusted. The exit gate consumes the 033.5 DelegationResult and treats its `diff`
 * (taken vs the PRE-delegation tree — which guards against in-sandbox git tampering)
 * as an UNTRUSTED patch proposal, passing it through the full pipeline:
 *
 *     write-set check → spec gate → validator → per-story regression → Assessor
 *
 * INVARIANT (invariant-tested): 100% of the sandbox's changes pass the write-set
 * check, ZERO exceptions. A single out-of-write-set file rejects the WHOLE proposal.
 * The agent's self-report is NEVER part of the verdict — diagnosis only. The verdict
 * always derives from the diff.
 *
 * Identical regardless of driver (headless today, acp later).
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 * CI-safe: pure + injected runners; no container, no network, no real process.
 */

import {
  validateWriteSet,
  specConformanceGate,
  runRegressionGate,
  type PriorStoryAcceptance,
  type BaselineRunner,
} from '@gateloop/validator-suite';
import { diffFileSet, type DelegationResult } from './delegationResult';

export interface ExitGateContract {
  story_id: string;
  /** The ONLY files the delegation may have changed. Enforced with zero exceptions. */
  allowed_write_set: string[];
  acceptance_criteria?: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export type ExitGateStage =
  | 'result_valid'
  | 'write_set'
  | 'spec'
  | 'validator'
  | 'regression'
  | 'assessor';

export interface ExitGateStageResult {
  stage: ExitGateStage;
  ok: boolean;
  errors: string[];
  /** True if the stage was not run (an earlier stage rejected the whole proposal). */
  skipped?: boolean;
}

export interface ExitGateVerdict {
  accepted: boolean;
  /** True iff a change fell outside the write-set ⇒ the WHOLE proposal is rejected. */
  rejected_whole: boolean;
  /** The AUTHORITATIVE changed-file set, parsed from the diff (not the self-report). */
  changed_files: string[];
  /** Changed files that fall outside the allowed write-set (empty ⇒ all in-set). */
  out_of_write_set: string[];
  stages: ExitGateStageResult[];
  /** The self-report plays NO part in the verdict. Always true. */
  self_report_excluded: true;
  /** Carried from the result (lie-detection etc.) — diagnosis only, never gating. */
  warnings: string[];
}

/** Context passed to injected validator / Assessor stages. */
export interface ExitGateStageContext {
  diff: string;
  changed_files: string[];
  contract: ExitGateContract;
}

export interface ExitGateGates {
  /** Optional validator (e.g. build/test/typecheck quality bar). Injected, deterministic. */
  validator?: (ctx: ExitGateStageContext) => Promise<ValidationResult> | ValidationResult;
  /** Per-story regression gate: prior acceptance tests + an injected runner. */
  regression?: { prior: PriorStoryAcceptance[]; runner: BaselineRunner };
  /**
   * Assessor stage. Injected so agent-delegate stays decoupled from assessor-runtime;
   * the harness wires the real `runAssessor` here. Verdict derives from its tests.
   */
  assessor?: (ctx: ExitGateStageContext) => Promise<ValidationResult> | ValidationResult;
}

/**
 * Synthesize an untrusted patch proposal from the authoritative diff, for the spec
 * gate. The diff — never the agent's claim — is the source of `changed_files`.
 */
function untrustedProposalFromDiff(result: DelegationResult, changed_files: string[], contract: ExitGateContract): Record<string, unknown> {
  return {
    proposal_id: `delegation_${contract.story_id}`,
    story_id: contract.story_id,
    contract_id: contract.story_id,
    change_type: 'delegation_untrusted_patch',
    changed_files,
    // Reversible: the sandbox is disposable; rollback = discard the workspace copy.
    rollback_notes: 'delegation sandbox is disposable; rollback = discard the sandbox working copy (no host mutation occurred)',
    // The diff is carried for reference; the gate keys off changed_files (from the diff).
    diff: result.diff,
  };
}

/**
 * Run the exit gate over a DelegationResult. Stages run in order; the write-set check
 * is the hard crux — any out-of-write-set change rejects the whole proposal and the
 * downstream stages are skipped. The verdict is accepted ONLY if every stage passed
 * AND zero changed files fell outside the write-set.
 */
export async function runExitGate(
  result: DelegationResult,
  contract: ExitGateContract,
  gates: ExitGateGates = {},
): Promise<ExitGateVerdict> {
  const stages: ExitGateStageResult[] = [];
  const warnings = [...(result.warnings ?? [])];

  // Stage 0 — the result must be structurally usable and carry a diff. We do NOT
  // consult agent_self_report / claimed_changes anywhere in the verdict.
  const resultOk = typeof result.diff === 'string';
  stages.push({
    stage: 'result_valid',
    ok: resultOk,
    errors: resultOk ? [] : ['delegation result has no authoritative diff'],
  });

  // The AUTHORITATIVE change set — parsed from the diff, which was taken vs the
  // pre-delegation tree (so in-sandbox `git` tampering cannot hide a change).
  const changed_files = resultOk ? diffFileSet(result.diff) : [];

  // Stage 1 — WRITE-SET (the crux). Zero exceptions.
  const writeSet = resultOk
    ? validateWriteSet(changed_files, contract.allowed_write_set)
    : { ok: false, errors: ['no diff to check'] };
  const out_of_write_set = changed_files.filter(
    (f) => !contract.allowed_write_set.some((g) => globMatch(g, f)),
  );
  stages.push({ stage: 'write_set', ok: writeSet.ok && out_of_write_set.length === 0, errors: writeSet.errors });

  const rejected_whole = !resultOk || out_of_write_set.length > 0;

  if (rejected_whole) {
    // Hard stop: a single out-of-bounds change rejects the WHOLE proposal. Downstream
    // stages are skipped — there is nothing to validate once the boundary is breached.
    for (const stage of ['spec', 'validator', 'regression', 'assessor'] as const) {
      stages.push({ stage, ok: false, errors: ['skipped — proposal rejected at the write-set boundary'], skipped: true });
    }
    return { accepted: false, rejected_whole: true, changed_files, out_of_write_set, stages, self_report_excluded: true, warnings };
  }

  const ctx: ExitGateStageContext = { diff: result.diff, changed_files, contract };

  // Stage 2 — SPEC conformance (untrusted proposal synthesized from the diff).
  const spec = specConformanceGate({
    proposal: untrustedProposalFromDiff(result, changed_files, contract),
    contract: { allowed_write_set: contract.allowed_write_set, acceptance_criteria: contract.acceptance_criteria },
  });
  stages.push({ stage: 'spec', ok: spec.ok, errors: spec.errors });

  // Stage 3 — VALIDATOR (injected; e.g. quality bar). Absent ⇒ pass-through.
  const validator = gates.validator ? await gates.validator(ctx) : { ok: true, errors: [] };
  stages.push({ stage: 'validator', ok: validator.ok, errors: validator.errors });

  // Stage 4 — per-story REGRESSION gate (injected runner). Absent ⇒ pass-through.
  let regression: ValidationResult = { ok: true, errors: [] };
  if (gates.regression) {
    const r = await runRegressionGate(gates.regression.prior, gates.regression.runner);
    regression = { ok: r.ok, errors: r.broken.map((b) => `regression: ${b.story_id} :: ${b.test}`) };
  }
  stages.push({ stage: 'regression', ok: regression.ok, errors: regression.errors });

  // Stage 5 — ASSESSOR (injected; harness wires runAssessor). Absent ⇒ pass-through.
  const assessor = gates.assessor ? await gates.assessor(ctx) : { ok: true, errors: [] };
  stages.push({ stage: 'assessor', ok: assessor.ok, errors: assessor.errors });

  const accepted = stages.every((s) => s.ok) && out_of_write_set.length === 0;
  return { accepted, rejected_whole: false, changed_files, out_of_write_set, stages, self_report_excluded: true, warnings };
}

/** Same glob semantics as validator-suite's write-set matcher (single-source intent). */
function globMatch(glob: string, p: string): boolean {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '§')
        .replace(/\*/g, '[^/]*')
        .replace(/§/g, '.*') +
      '$',
  );
  return re.test(p);
}

/**
 * The INVARIANT, as a callable assertion (used by the invariant test and available to
 * the harness): for ANY accepted verdict, every changed file is within the write-set —
 * zero exceptions. Returns the offending files if the invariant is ever violated.
 */
export function assertWriteSetInvariant(verdict: ExitGateVerdict): ValidationResult {
  if (verdict.accepted && verdict.out_of_write_set.length > 0) {
    return {
      ok: false,
      errors: verdict.out_of_write_set.map((f) => `INVARIANT VIOLATION: accepted proposal changed out-of-write-set file ${f}`),
    };
  }
  return { ok: true, errors: [] };
}
