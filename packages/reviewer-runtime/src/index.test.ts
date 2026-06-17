import { describe, it, expect } from 'vitest';
import {
  runReviewer, classifyTestValidity, reviewTestValidity,
  type ReviewerInput, type AcceptanceTestUnderReview,
} from './index.js';
import { createScriptedReviewer } from './scripted.js';
import { readJsonl } from '@gateloop/event-log';
import { validateSettings } from '@gateloop/settings';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

const baseInput: ReviewerInput = {
  story_id: 'STORY-X',
  failing_test_output: 'AssertionError: expected 5 but received NaN',
  acceptance_criteria: 'divide(10, 2) === 5',
  diff_under_review:
    '-export const divide = (a, b) => a / b;\n' +
    '+export const divide = (a, b) => { if (b===0) throw new Error("DivideByZero"); return a/b; };',
  matching_genes: [],
};

const validPartialReport = {
  story_id: 'STORY-X',
  failure_classification: 'test_assertion_mismatch' as const,
  root_cause_hypotheses: [
    {
      hypothesis: 'Division by zero not guarded before arithmetic.',
      confidence: 0.9,
      evidence_lines: ['src/calc.ts:12'],
    },
  ],
  improvement_directions: [
    {
      direction_type: 'change_implementation' as const,
      rationale: 'Add zero-guard before division to prevent NaN result.',
      affected_files: ['src/calc.ts'],
    },
  ],
  do_not_touch: ['test/'],
  referenced_gene_signals: [],
};

function tmpTrace(): string {
  return join(tmpdir(), `rv-trace-${Math.floor(Math.random() * 1e9)}.jsonl`);
}

function cleanup(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

describe('reviewer-runtime', () => {
  it('reviewer_emits_schema_valid_diagnosis', async () => {
    const trace = tmpTrace();
    try {
      const strategy = createScriptedReviewer(validPartialReport);
      const result = await runReviewer(baseInput, { strategy, traceLogPath: trace });
      expect(result.valid).toBe(true);
      expect(result.validationErrors).toHaveLength(0);
    } finally {
      cleanup(trace);
    }
  });

  it('reviewer_holds_no_write_set', async () => {
    const trace = tmpTrace();
    try {
      // Inject a write_set field via a rogue partial report — must be stripped.
      const strategy = createScriptedReviewer({
        ...validPartialReport,
        write_set: ['src/**'],
      } as Record<string, unknown>);
      const result = await runReviewer(baseInput, { strategy, traceLogPath: trace });
      expect((result.report as Record<string, unknown>).write_set).toBeUndefined();
    } finally {
      cleanup(trace);
    }
  });

  it('diagnosis_written_to_trace', async () => {
    const trace = tmpTrace();
    try {
      const strategy = createScriptedReviewer(validPartialReport);
      await runReviewer(baseInput, { strategy, traceLogPath: trace });
      const events = readJsonl(trace);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('reviewer_diagnosis');
    } finally {
      cleanup(trace);
    }
  });

  it('scripted_reviewer_fills_required_fields', async () => {
    const strategy = createScriptedReviewer(validPartialReport);
    const report = await strategy.review(baseInput);
    expect(report.report_id).toBeTruthy();
    expect(report.reviewed_at).toBeTruthy();
    expect(report.reviewer_model).toBe('scripted-reviewer-v1');
  });

  it('reviewer_cannot_change_goal_or_acceptance', async () => {
    const trace = tmpTrace();
    try {
      // A rogue strategy that injects acceptance_criteria — must be stripped.
      const rogueStrategy = createScriptedReviewer({
        ...validPartialReport,
        acceptance_criteria: 'OVERRIDE',
      } as Record<string, unknown>);
      const result = await runReviewer(baseInput, {
        strategy: rogueStrategy,
        traceLogPath: trace,
      });
      expect((result.report as Record<string, unknown>).acceptance_criteria).toBeUndefined();
    } finally {
      cleanup(trace);
    }
  });
});

// ── STORY-023.5: on_cycle_complete trigger ────────────────────────────────────

describe('on-cycle-complete-trigger', () => {
  it('on_cycle_complete_trigger_available', () => {
    expect(validateSettings({ review: { trigger: 'on_cycle_complete' } }).ok).toBe(true);
  });
});

// ── STORY-030.6: Reviewer audits acceptance-test validity ─────────────────────

describe('STORY-030.6 test_validity', () => {
  const VACUOUS: AcceptanceTestUnderReview = {
    path: 'pkg/src/__acceptance__/a.acceptance.test.ts',
    intent_id: 'limiter_rejects_over_quota',
    content: "test('x', () => { expect(true).toBe(true); });",
  };
  const NO_ASSERT: AcceptanceTestUnderReview = {
    path: 'pkg/src/__acceptance__/b.acceptance.test.ts',
    intent_id: 'limiter_allows_under_quota',
    content: "test('x', () => { /* TODO: assert something */ });",
  };
  const OVER_FIT: AcceptanceTestUnderReview = {
    path: 'pkg/src/__acceptance__/c.acceptance.test.ts',
    intent_id: 'adder_adds',
    content: "test('x', () => { expect(add(2, 2)).toBe(4); });",
  };
  const MEANINGFUL: AcceptanceTestUnderReview = {
    path: 'pkg/src/__acceptance__/d.acceptance.test.ts',
    intent_id: 'limiter_rejects_over_quota',
    content: "test('x', () => { const r = limit(5); expect(r).toBe(true); expect(limit(0)).toBe(false); });",
  };

  it('vacuous_tests_flagged', () => {
    expect(classifyTestValidity(VACUOUS.content)).toBe('vacuous');
    expect(classifyTestValidity(NO_ASSERT.content)).toBe('vacuous');
    const findings = reviewTestValidity([VACUOUS, NO_ASSERT]);
    expect(findings).toHaveLength(2);
    expect(findings.every(f => f.verdict === 'vacuous')).toBe(true);
  });

  it('over_fit_tests_flagged', () => {
    expect(classifyTestValidity(OVER_FIT.content)).toBe('over_fit');
    const findings = reviewTestValidity([OVER_FIT]);
    expect(findings).toHaveLength(1);
    expect(findings[0].verdict).toBe('over_fit');
    expect(findings[0].intent_id).toBe('adder_adds');
  });

  it('meaningful tests are not flagged', () => {
    expect(classifyTestValidity(MEANINGFUL.content)).toBe('meaningful');
    expect(reviewTestValidity([MEANINGFUL])).toHaveLength(0);
  });

  it('finding_is_advisory', () => {
    const findings = reviewTestValidity([VACUOUS, OVER_FIT]);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every(f => f.advisory === true)).toBe(true);
    expect(findings.every(f => f.finding_type === 'test_validity')).toBe(true);
  });

  it('reviewer_emits_test_validity_finding: attached to the diagnosis report, report stays valid', async () => {
    const trace = tmpTrace();
    try {
      const strategy = createScriptedReviewer(validPartialReport);
      const result = await runReviewer(
        { ...baseInput, acceptance_tests: [VACUOUS, MEANINGFUL] },
        { strategy, traceLogPath: trace },
      );
      // advisory findings present, report still schema-valid (advisory never blocks)
      expect(result.valid).toBe(true);
      const findings = (result.report as any).test_validity_findings;
      expect(Array.isArray(findings)).toBe(true);
      expect(findings).toHaveLength(1); // only the vacuous one flagged
      expect(findings[0].verdict).toBe('vacuous');
    } finally {
      cleanup(trace);
    }
  });
});
