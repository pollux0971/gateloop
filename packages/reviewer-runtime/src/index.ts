/**
 * @gateloop/reviewer-runtime
 * Reviewer agent runtime — read-only advisory leaf.
 *
 * INVARIANTS (enforced here, not by prompt politeness):
 *   1. Reviewer holds no write-set — `write_set` / `allowed_write_set` are stripped.
 *   2. Reviewer cannot change goal or acceptance_criteria — stripped if injected.
 *   3. Reviewer cannot dispatch agents — output is a diagnosis report only.
 *   4. Report is appended to trace; Supervisor reads and decides.
 *
 * Owner: STORY-022.2
 */
import { validateDiagnosisReport } from '@gateloop/validator-suite';
import type { DiagnosisReport } from '@gateloop/validator-suite';
import { appendNextEvent } from '@gateloop/event-log';
import type { FailureGene } from '@gateloop/failure-bank';

export type { DiagnosisReport } from '@gateloop/validator-suite';

// ── Input / Options / Result types ───────────────────────────────────────────

export interface ReviewerInput {
  story_id: string;
  failing_test_output: string;
  acceptance_criteria: string;
  diff_under_review: string;
  matching_genes: FailureGene[];
  /** STORY-030.6: acceptance tests under review (e.g. authored by the Assessor). */
  acceptance_tests?: AcceptanceTestUnderReview[];
  /** STORY-030.6: the acceptance intent those tests are supposed to exercise. */
  acceptance_intent?: { behaviors: IntentBehaviorRef[] };
}

// ── STORY-030.6: test_validity — does the acceptance suite test the right thing? ─
//
// The Reviewer gains a global, ADVISORY duty: audit whether the acceptance tests
// (authored by the Assessor) actually exercise the requirement intent, or are
// vacuous (assert nothing real) / over-fit (pin one hardcoded case). No single
// agent both authors and audits the bar — the Assessor authors, the Reviewer
// audits. Design: docs/agents/07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md.

export interface AcceptanceTestUnderReview {
  path: string;
  intent_id: string;
  content: string;
}

export interface IntentBehaviorRef {
  id: string;
  target: string;
}

export type TestValidityVerdict = 'vacuous' | 'over_fit' | 'meaningful';

export interface TestValidityFinding {
  finding_type: 'test_validity';
  /** Only problems are flagged: vacuous or over_fit. */
  verdict: 'vacuous' | 'over_fit';
  test_path: string;
  intent_id: string;
  rationale: string;
  /** STORY-030.6: the Reviewer is advisory — this never blocks, only informs. */
  advisory: true;
}

function isLiteral(s: string): boolean {
  return /^(true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`]*`)$/.test(s.trim());
}

function extractAssertions(content: string): Array<{ lhs: string; rhs: string }> {
  const re = /expect\(\s*([\s\S]*?)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*([\s\S]*?)\s*\)/g;
  const out: Array<{ lhs: string; rhs: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push({ lhs: m[1].trim(), rhs: m[2].trim() });
  return out;
}

/** True when an expression is a single call whose arguments are all literals (one hardcoded case). */
function callWithAllLiteralArgs(expr: string): boolean {
  const m = /^[A-Za-z_$][\w$.]*\(([\s\S]*)\)$/.exec(expr.trim());
  if (!m) return false;
  const inner = m[1].trim();
  if (inner === '') return false;
  return inner.split(',').every(a => isLiteral(a));
}

/**
 * STORY-030.6: classify an acceptance test's honesty (heuristic, advisory).
 *   - vacuous   — no real assertion, or every assertion is a literal tautology.
 *   - over_fit  — a single assertion pinning one hardcoded output for one hardcoded
 *                 input (the classic "hardcoded to pass the one example").
 *   - meaningful — otherwise.
 */
export function classifyTestValidity(content: string): TestValidityVerdict {
  const assertions = extractAssertions(content);
  if (assertions.length === 0) return 'vacuous';
  const allTautology = assertions.every(a => a.lhs === a.rhs && isLiteral(a.lhs));
  if (allTautology) return 'vacuous';
  if (assertions.length === 1 && isLiteral(assertions[0].rhs) && callWithAllLiteralArgs(assertions[0].lhs)) {
    return 'over_fit';
  }
  return 'meaningful';
}

/**
 * STORY-030.6: audit the acceptance tests and emit advisory test_validity findings
 * for the vacuous / over-fit ones. Meaningful tests produce no finding.
 */
export function reviewTestValidity(
  acceptanceTests: AcceptanceTestUnderReview[],
): TestValidityFinding[] {
  const findings: TestValidityFinding[] = [];
  for (const t of acceptanceTests) {
    const verdict = classifyTestValidity(t.content);
    if (verdict === 'meaningful') continue;
    findings.push({
      finding_type: 'test_validity',
      verdict,
      test_path: t.path,
      intent_id: t.intent_id,
      rationale: verdict === 'vacuous'
        ? `acceptance test ${t.path} asserts nothing that exercises intent "${t.intent_id}" (vacuous)`
        : `acceptance test ${t.path} pins one hardcoded case for intent "${t.intent_id}" (over-fit)`,
      advisory: true,
    });
  }
  return findings;
}

export interface ReviewStrategy {
  review(input: ReviewerInput): Promise<DiagnosisReport>;
}

export interface ReviewerOptions {
  strategy: ReviewStrategy;
  traceLogPath: string;
  /** Model name recorded in the trace event. Default: 'scripted-reviewer-v1' */
  reviewerModel?: string;
}

export interface ReviewerResult {
  report: DiagnosisReport;
  valid: boolean;
  validationErrors: string[];
}

// ── Forbidden field lists (enforced deterministically) ────────────────────────

/** Fields that grant or imply write authority — must never appear on a diagnosis report. */
const WRITE_SET_FIELDS = ['write_set', 'allowed_write_set'] as const;

/** Fields that would alter story scope — Reviewer may read but never override. */
const GOAL_FIELDS = ['acceptance_criteria', 'story_goal', 'objective'] as const;

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run the Reviewer — read-only advisory leaf.
 *
 * Steps:
 *   1. Delegate to the injected ReviewStrategy (LLM or scripted fixture).
 *   2. Strip any write-set fields (invariant 1).
 *   3. Strip any goal/acceptance_criteria overrides (invariant 2).
 *   4. Validate the resulting report with validateDiagnosisReport.
 *   5. Append a `reviewer_diagnosis` event to the trace.
 *   6. Return { report, valid, validationErrors }.
 */
export async function runReviewer(
  input: ReviewerInput,
  opts: ReviewerOptions,
): Promise<ReviewerResult> {
  const rawReport = await opts.strategy.review(input);

  // Cast to a mutable record so we can enforce structural invariants.
  const report = { ...rawReport } as Record<string, unknown>;

  // Invariant 1: Reviewer holds no write-set.
  for (const field of WRITE_SET_FIELDS) {
    delete report[field];
  }

  // Invariant 2: Reviewer cannot change story goal or acceptance_criteria.
  for (const field of GOAL_FIELDS) {
    delete report[field];
  }

  // STORY-030.6: attach advisory test_validity findings auditing the acceptance
  // tests. Advisory only — it never blocks; it informs the Supervisor whether the
  // bar the Assessor authored is honest.
  if (input.acceptance_tests && input.acceptance_tests.length > 0) {
    (report as Record<string, unknown>).test_validity_findings = reviewTestValidity(input.acceptance_tests);
  }

  const cleanReport = report as DiagnosisReport;

  // Validate schema conformance.
  const validation = validateDiagnosisReport(cleanReport);

  // Append to trace (append-only; harness decides what Supervisor reads).
  appendNextEvent(opts.traceLogPath, {
    run_id: input.story_id,
    type: 'reviewer_diagnosis',
    agent_role: 'reviewer',
    payload: {
      report: cleanReport,
      validationErrors: validation.errors,
    },
  });

  return {
    report: cleanReport,
    valid: validation.ok,
    validationErrors: validation.errors,
  };
}
