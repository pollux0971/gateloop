import { describe, it, expect } from 'vitest';
import {
  runAssessor,
  validateAssessmentReport,
  assertAssessorWritesNoProductCode,
  isTestFilePath,
  isProductCodePath,
  type AssessorInput,
  type AssessStrategy,
  type AuthoredAcceptanceTest,
  type AssessmentTestResult,
  type AcceptanceIntentLike,
  type DeliveredResult,
} from './index';

const INTENT: AcceptanceIntentLike = {
  authored_at: 'planning',
  behaviors: [
    { id: 'limiter_rejects_over_quota', kind: 'behavior', target: 'limiter rejects over quota' },
    { id: 'limiter_allows_under_quota', kind: 'behavior', target: 'limiter allows under quota' },
  ],
};

const RESULT: DeliveredResult = {
  story_id: 'STORY-042.1',
  changed_files: ['gateloop/packages/api/src/rate-limiter.ts'],
  files: { 'gateloop/packages/api/src/rate-limiter.ts': 'export const limit = () => true;' },
};

const FIXED = '2026-06-16T00:00:00.000Z';

// A scripted strategy: authors one acceptance test per intent behaviour, and runs
// them with a caller-supplied pass/fail map (no real test runner — CI-safe).
function scriptedStrategy(passMap: Record<string, boolean>, opts?: { productCode?: boolean }): AssessStrategy {
  return {
    async authorTests(input: AssessorInput): Promise<AuthoredAcceptanceTest[]> {
      return input.intent.behaviors.map(b => ({
        path: opts?.productCode
          ? `gateloop/packages/api/src/${b.id}.ts`               // illegal: product code
          : `gateloop/packages/api/src/__acceptance__/${b.id}.acceptance.test.ts`,
        intent_id: b.id,
        content: `import { test, expect } from 'vitest';\ntest('${b.id}', () => { expect(true).toBe(true); });`,
      }));
    },
    async runTests(tests: AuthoredAcceptanceTest[]): Promise<AssessmentTestResult[]> {
      return tests.map(t => ({
        intent_id: t.intent_id,
        test_path: t.path,
        passed: passMap[t.intent_id] ?? false,
        detail: passMap[t.intent_id] ? 'assertion held' : 'assertion failed',
      }));
    },
  };
}

const ALL_PASS = { limiter_rejects_over_quota: true, limiter_allows_under_quota: true };

describe('STORY-030.3 assessor-runtime', () => {
  it('assessor_authors_concrete_tests_from_intent', async () => {
    const r = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessedAt: FIXED },
    );
    // one concrete test authored per intent behaviour, each mapped to an intent id
    expect(r.report.authored_tests).toHaveLength(2);
    expect(r.report.authored_tests.map(t => t.intent_id).sort())
      .toEqual(['limiter_allows_under_quota', 'limiter_rejects_over_quota']);
    for (const t of r.report.authored_tests) {
      expect(t.content).toContain('test(');
      expect(isTestFilePath(t.path)).toBe(true);
    }
  });

  it('assessor_runs_tests_and_emits_verdict', async () => {
    const pass = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessedAt: FIXED },
    );
    expect(pass.report.verdict).toBe('pass');
    expect(pass.report.satisfied_intent_ids).toHaveLength(2);
    expect(pass.report.unsatisfied_intent_ids).toHaveLength(0);
    expect(pass.report.results).toHaveLength(2);

    // a failing test → fail verdict, with the failing intent surfaced
    const fail = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy({ limiter_rejects_over_quota: true, limiter_allows_under_quota: false }), assessedAt: FIXED },
    );
    expect(fail.report.verdict).toBe('fail');
    expect(fail.report.unsatisfied_intent_ids).toContain('limiter_allows_under_quota');
  });

  it('verdict_is_computed_from_results_not_asserted: an unrun intent stays unsatisfied', async () => {
    // strategy that only authors/runs ONE of the two intent behaviours
    const partial: AssessStrategy = {
      async authorTests() {
        return [{ path: 'pkg/src/__acceptance__/a.acceptance.test.ts', intent_id: 'limiter_rejects_over_quota', content: 'test()' }];
      },
      async runTests(tests) {
        return tests.map(t => ({ intent_id: t.intent_id, test_path: t.path, passed: true, detail: 'ok' }));
      },
    };
    const r = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: partial, assessedAt: FIXED },
    );
    // the un-tested behaviour cannot be declared satisfied → verdict fail
    expect(r.report.verdict).toBe('fail');
    expect(r.report.unsatisfied_intent_ids).toContain('limiter_allows_under_quota');
  });

  it('assessor_writes_no_product_code', async () => {
    expect(isProductCodePath('gateloop/packages/api/src/rate-limiter.ts')).toBe(true);
    expect(isProductCodePath('pkg/src/__acceptance__/x.acceptance.test.ts')).toBe(false);
    // direct guard
    const guard = assertAssessorWritesNoProductCode([
      { path: 'pkg/src/foo.ts', intent_id: 'x', content: '' },
    ]);
    expect(guard.ok).toBe(false);
    // end-to-end: a strategy that authors product code is rejected
    await expect(runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS, { productCode: true }), assessedAt: FIXED },
    )).rejects.toThrow(/assessor_wrote_product_code/);
  });

  it('verdict_conforms_to_schema', async () => {
    const r = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessedAt: FIXED, assessorModel: 'gpt-strong' },
    );
    expect(r.valid).toBe(true);
    expect(r.validationErrors).toHaveLength(0);
    expect(validateAssessmentReport(r.report).ok).toBe(true);
    // a malformed report is rejected
    expect(validateAssessmentReport({ report_id: 'x' }).ok).toBe(false);
    expect(validateAssessmentReport({ ...r.report, verdict: 'maybe' }).ok).toBe(false);
  });

  it('cross_model_from_developer_by_default', async () => {
    // same model as the developer → rejected (assessment would not be independent)
    await expect(runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessorModel: 'cheap-coder', developerModel: 'cheap-coder' },
    )).rejects.toThrow(/cross-model/);
    // different models → fine
    const r = await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessorModel: 'strong-assessor', developerModel: 'cheap-coder', assessedAt: FIXED },
    );
    expect(r.report.assessor_model).toBe('strong-assessor');
  });

  it('emits a verdict to the injected trace sink', async () => {
    const events: Array<{ type: string }> = [];
    await runAssessor(
      { story_id: 'STORY-042.1', intent: INTENT, result: RESULT },
      { strategy: scriptedStrategy(ALL_PASS), assessedAt: FIXED, trace: (e) => events.push(e) },
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('assessor_verdict');
  });
});
