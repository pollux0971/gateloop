/**
 * @gateloop/assessor-runtime
 *
 * The Assessor agent runtime (STORY-030.3). The Assessor takes a story's
 * acceptance_intent (authored at planning time by the Planning Steward, STORY-030.1)
 * plus the delivered result, AUTHORS concrete acceptance tests from that intent,
 * RUNS them against the result, and emits a satisfaction verdict conforming to
 * specs/assessment_report.schema.json.
 *
 * INVARIANTS (enforced here, not by prompt politeness):
 *   1. The Assessor writes acceptance TESTS only — never product code. An authored
 *      file that is not a test file is rejected before the report is emitted.
 *   2. Tests are authored FROM the acceptance_intent — every authored test maps to
 *      an intent id that exists in the intent.
 *   3. The verdict is COMPUTED from test results, never asserted by the model
 *      (the Assessor may not author its own pass verdict without running the tests).
 *   4. Cross-model from the Developer by default — the assessor model is recorded
 *      and, when the developer model is known, asserted to differ.
 *
 * Design: docs/agents/07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md
 */

// ── Intent (structural; authored by Planning, STORY-030.1) ────────────────────

export type AcceptanceIntentKind = 'behavior' | 'file_exists' | 'command';

export interface AcceptanceIntentItem {
  id: string;
  kind: AcceptanceIntentKind;
  target: string;
}

export interface AcceptanceIntentLike {
  authored_at: 'planning';
  behaviors: AcceptanceIntentItem[];
}

// ── Delivered result (result only — never the generation process) ─────────────

export interface DeliveredResult {
  story_id: string;
  /** Files the Developer/Debugger delivered (code + their own tests). */
  changed_files: string[];
  /** Optional file contents the Assessor may inspect — the outcome, not the process. */
  files?: Record<string, string>;
}

// ── Assessor outputs ──────────────────────────────────────────────────────────

export interface AuthoredAcceptanceTest {
  /** Path of the authored test file — must be a test file, never product code. */
  path: string;
  /** The acceptance_intent behaviour id this test exercises. */
  intent_id: string;
  /** Concrete test source authored by the Assessor. */
  content: string;
}

export interface AssessmentTestResult {
  intent_id: string;
  test_path: string;
  passed: boolean;
  detail: string;
}

export interface AssessmentReport {
  report_id: string;
  story_id: string;
  authored_tests: AuthoredAcceptanceTest[];
  results: AssessmentTestResult[];
  verdict: 'pass' | 'fail';
  satisfied_intent_ids: string[];
  unsatisfied_intent_ids: string[];
  evidence: string[];
  assessor_model: string;
  assessed_at: string;
}

// ── Injected strategy (LLM or scripted fixture) and trace sink ────────────────

export interface AssessorInput {
  story_id: string;
  intent: AcceptanceIntentLike;
  result: DeliveredResult;
}

export interface AssessStrategy {
  /** Author concrete acceptance tests from the intent + delivered result. */
  authorTests(input: AssessorInput): Promise<AuthoredAcceptanceTest[]>;
  /** Run the authored tests against the delivered result; one result per test. */
  runTests(tests: AuthoredAcceptanceTest[], result: DeliveredResult): Promise<AssessmentTestResult[]>;
}

export interface TraceSink {
  (event: { run_id: string; type: string; agent_role: 'assessor'; payload: Record<string, unknown> }): void;
}

export interface AssessorOptions {
  strategy: AssessStrategy;
  /** Model that ran the Assessor (recorded; cross-model from the Developer). */
  assessorModel?: string;
  /** The Developer's model, when known — used to assert cross-model isolation. */
  developerModel?: string;
  /** Injected timestamp for a deterministic assessed_at; defaults to now(). */
  assessedAt?: string;
  /** Optional trace sink — the harness owns event-log; the Assessor stays dependency-free. */
  trace?: TraceSink;
}

export interface AssessorResult {
  report: AssessmentReport;
  valid: boolean;
  validationErrors: string[];
}

export interface ValidationResult { ok: boolean; errors: string[] }

// ── Product-code vs test-file guard (INVARIANT 1) ─────────────────────────────

const TEST_FILE_RE = /(?:\.(?:test|spec|acceptance)\.[cm]?[jt]sx?|(?:^|\/)(?:__tests__|__acceptance__)\/)/;

/** A path is a test file (the only thing the Assessor may author). */
export function isTestFilePath(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/** A path the Assessor must NOT author — anything that is not a test file is product code. */
export function isProductCodePath(path: string): boolean {
  return !isTestFilePath(path);
}

/**
 * INVARIANT 1: every authored file must be a test file. Returns the offending
 * (product-code) paths the Assessor illegally tried to author.
 */
export function assertAssessorWritesNoProductCode(tests: AuthoredAcceptanceTest[]): ValidationResult {
  const violations = tests.filter(t => isProductCodePath(t.path)).map(t => `assessor_wrote_product_code: ${t.path}`);
  return { ok: violations.length === 0, errors: violations };
}

// ── Report validation against assessment_report.schema.json ───────────────────

const REQUIRED_REPORT_FIELDS = [
  'report_id', 'story_id', 'authored_tests', 'results', 'verdict',
  'satisfied_intent_ids', 'unsatisfied_intent_ids', 'evidence',
  'assessor_model', 'assessed_at',
] as const;

/** Structural validation mirroring specs/assessment_report.schema.json. */
export function validateAssessmentReport(report: unknown): ValidationResult {
  if (typeof report !== 'object' || report === null) {
    return { ok: false, errors: ['assessment report must be a non-null object'] };
  }
  const r = report as Record<string, unknown>;
  const errors: string[] = [];
  for (const f of REQUIRED_REPORT_FIELDS) {
    if (r[f] === undefined || r[f] === null) errors.push(`missing required field: ${f}`);
  }
  if (r.verdict !== 'pass' && r.verdict !== 'fail') {
    errors.push('verdict must be "pass" or "fail"');
  }
  for (const arr of ['authored_tests', 'results', 'satisfied_intent_ids', 'unsatisfied_intent_ids', 'evidence'] as const) {
    if (r[arr] !== undefined && !Array.isArray(r[arr])) errors.push(`${arr} must be an array`);
  }
  if (typeof r.assessor_model === 'string' && !r.assessor_model.trim()) {
    errors.push('assessor_model must be non-empty');
  }
  return { ok: errors.length === 0, errors };
}

// ── Core: runAssessor ─────────────────────────────────────────────────────────

/**
 * Run the Assessor. Authors concrete acceptance tests from the intent, enforces
 * the no-product-code invariant, runs the tests against the delivered result, and
 * computes the verdict from the results (never from the model). Cross-model from
 * the Developer is asserted when both models are known. Optionally appends a
 * `assessor_verdict` event via the injected trace sink.
 */
export async function runAssessor(input: AssessorInput, opts: AssessorOptions): Promise<AssessorResult> {
  const assessorModel = opts.assessorModel ?? 'scripted-assessor-v1';

  // INVARIANT 4: cross-model from the Developer by default.
  if (opts.developerModel && opts.developerModel === assessorModel) {
    throw new Error(
      `assessor must be cross-model from the developer (both are "${assessorModel}") — assessment would not be independent`,
    );
  }

  const intentIds = new Set(input.intent.behaviors.map(b => b.id));

  // 1. Author concrete tests from the intent.
  const authored = await opts.strategy.authorTests(input);

  // INVARIANT 1: the Assessor writes tests only — never product code.
  const noProductCode = assertAssessorWritesNoProductCode(authored);
  if (!noProductCode.ok) {
    throw new Error(noProductCode.errors.join('; '));
  }

  // INVARIANT 2: every authored test maps to an intent id that exists.
  const orphan = authored.filter(t => !intentIds.has(t.intent_id)).map(t => t.intent_id);
  if (orphan.length > 0) {
    throw new Error(`assessor authored tests for unknown intent ids: ${[...new Set(orphan)].join(', ')}`);
  }

  // 2. Run the authored tests against the delivered result.
  const results = await opts.strategy.runTests(authored, input.result);

  // 3. INVARIANT 3: compute the verdict from results — not from the model.
  const passedByIntent = new Map<string, boolean>();
  for (const id of intentIds) passedByIntent.set(id, false);
  for (const res of results) {
    if (!intentIds.has(res.intent_id)) continue;
    // an intent is satisfied iff it has at least one authored test and all its results pass
    const prior = passedByIntent.get(res.intent_id);
    passedByIntent.set(res.intent_id, (prior === false ? true : prior!) && res.passed);
  }
  // an intent with no result at all stays unsatisfied
  const resultIntentIds = new Set(results.map(r => r.intent_id));
  for (const id of intentIds) {
    if (!resultIntentIds.has(id)) passedByIntent.set(id, false);
  }

  const satisfied = [...intentIds].filter(id => passedByIntent.get(id) === true).sort();
  const unsatisfied = [...intentIds].filter(id => passedByIntent.get(id) !== true).sort();
  const verdict: 'pass' | 'fail' = unsatisfied.length === 0 && satisfied.length > 0 ? 'pass' : 'fail';

  const evidence: string[] = [
    `authored ${authored.length} acceptance test(s) from ${intentIds.size} intent behaviour(s)`,
    `${satisfied.length}/${intentIds.size} intent behaviours satisfied`,
    ...results.map(r => `${r.passed ? 'PASS' : 'FAIL'} ${r.intent_id} (${r.test_path}): ${r.detail}`),
  ];

  const report: AssessmentReport = {
    report_id: `AR-${input.story_id}-001`,
    story_id: input.story_id,
    authored_tests: authored,
    results,
    verdict,
    satisfied_intent_ids: satisfied,
    unsatisfied_intent_ids: unsatisfied,
    evidence,
    assessor_model: assessorModel,
    assessed_at: opts.assessedAt ?? new Date().toISOString(),
  };

  const validation = validateAssessmentReport(report);

  if (opts.trace) {
    opts.trace({
      run_id: input.story_id,
      type: 'assessor_verdict',
      agent_role: 'assessor',
      payload: { report, validationErrors: validation.errors },
    });
  }

  return { report, valid: validation.ok, validationErrors: validation.errors };
}
