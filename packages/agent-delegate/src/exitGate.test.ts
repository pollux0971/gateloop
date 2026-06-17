import { describe, it, expect } from 'vitest';
import { runExitGate, assertWriteSetInvariant, type ExitGateContract } from './exitGate';
import { buildDelegationResult, type DelegationResult } from './delegationResult';
import type { AgentEvent } from './headlessDriver';
import type { BaselineRunner, PriorStoryAcceptance } from '@gateloop/validator-suite';

const done: AgentEvent = { cli: 'claude', kind: 'completion', summary: 'done', stop_reason: 'end_turn', tokens: { input: 5, output: 5 } };

function makeDiff(files: string[]): string {
  return files
    .map((f) => [`diff --git a/${f} b/${f}`, `--- a/${f}`, `+++ b/${f}`, '@@ -1 +1 @@', '-old', '+new'].join('\n'))
    .join('\n');
}

function makeResult(files: string[], opts?: { claimed?: string[] }): DelegationResult {
  return buildDelegationResult({
    cli: 'claude',
    diff: makeDiff(files),
    events: [done],
    self_report_raw: opts?.claimed ? { claimed_changes: opts.claimed } : undefined,
  });
}

const CONTRACT: ExitGateContract = {
  story_id: 'STORY-X',
  allowed_write_set: ['src/**', 'a.ts'],
  acceptance_criteria: { behaviors_must_pass: ['does_the_thing'] },
};

describe('agent-delegate / exit gate — security crux (STORY-033.6)', () => {
  // ── consumes_delegation_result_diff ──
  it('consumes_delegation_result_diff', async () => {
    const v = await runExitGate(makeResult(['src/x.ts', 'a.ts']), CONTRACT);
    // changed_files come from the AUTHORITATIVE diff, not the self-report
    expect(v.changed_files).toEqual(['a.ts', 'src/x.ts']);
    expect(v.accepted).toBe(true);
    expect(v.out_of_write_set).toEqual([]);
    expect(v.stages.find((s) => s.stage === 'write_set')!.ok).toBe(true);
    expect(assertWriteSetInvariant(v).ok).toBe(true);
  });

  // ── diff_is_untrusted_patch_proposal ──
  it('diff_is_untrusted_patch_proposal: self-report claiming in-set CANNOT rescue an out-of-set diff', async () => {
    // the agent CLAIMS it only touched a.ts, but the diff actually touches secret.ts
    const result = makeResult(['secret.ts'], { claimed: ['a.ts'] });
    const v = await runExitGate(result, CONTRACT);
    expect(v.self_report_excluded).toBe(true);
    expect(v.rejected_whole).toBe(true);     // the DIFF governs, not the claim
    expect(v.accepted).toBe(false);
    expect(v.out_of_write_set).toEqual(['secret.ts']);
    // lie-detection warning is carried (diagnosis) but did not drive the verdict
    expect(v.warnings.length).toBeGreaterThan(0);
    expect(assertWriteSetInvariant(v).ok).toBe(true);
  });

  // ── out_of_writeset_change_rejects_whole_proposal ──
  it('out_of_writeset_change_rejects_whole_proposal: one bad file rejects the WHOLE proposal', async () => {
    // a.ts is in-set, evil.ts is NOT — the whole proposal must reject
    const v = await runExitGate(makeResult(['a.ts', 'evil.ts']), CONTRACT);
    expect(v.rejected_whole).toBe(true);
    expect(v.accepted).toBe(false);
    expect(v.out_of_write_set).toEqual(['evil.ts']);
    // downstream stages are skipped once the boundary is breached
    for (const stage of ['spec', 'validator', 'regression', 'assessor'] as const) {
      const s = v.stages.find((x) => x.stage === stage)!;
      expect(s.skipped).toBe(true);
      expect(s.ok).toBe(false);
    }
    expect(assertWriteSetInvariant(v).ok).toBe(true);
  });

  it('rejects a result with no authoritative diff', async () => {
    const bad = { ...makeResult(['a.ts']), diff: undefined as unknown as string };
    const v = await runExitGate(bad, CONTRACT);
    expect(v.accepted).toBe(false);
    expect(v.rejected_whole).toBe(true);
    expect(v.stages.find((s) => s.stage === 'result_valid')!.ok).toBe(false);
  });

  it('downstream gate failures fail acceptance (in-set diff still passes write-set)', async () => {
    const inSet = makeResult(['src/x.ts']);

    const failValidator = await runExitGate(inSet, CONTRACT, { validator: () => ({ ok: false, errors: ['quality bar: tests failed'] }) });
    expect(failValidator.accepted).toBe(false);
    expect(failValidator.out_of_write_set).toEqual([]); // still 0 exceptions
    expect(assertWriteSetInvariant(failValidator).ok).toBe(true);

    const failAssessor = await runExitGate(inSet, CONTRACT, { assessor: async () => ({ ok: false, errors: ['assessor verdict: fail'] }) });
    expect(failAssessor.accepted).toBe(false);
    expect(failAssessor.stages.find((s) => s.stage === 'assessor')!.ok).toBe(false);

    // regression gate broken
    const runner: BaselineRunner = { runTests: async () => [{ name: 't1', passed: false }] };
    const prior: PriorStoryAcceptance[] = [{ story_id: 'STORY-PRIOR', acceptance_tests: ['t1'] }];
    const failReg = await runExitGate(inSet, CONTRACT, { regression: { prior, runner } });
    expect(failReg.accepted).toBe(false);
    expect(failReg.stages.find((s) => s.stage === 'regression')!.ok).toBe(false);
  });

  it('all gates passing + in-set diff ⇒ accepted', async () => {
    const runner: BaselineRunner = { runTests: async () => [{ name: 't1', passed: true }] };
    const prior: PriorStoryAcceptance[] = [{ story_id: 'STORY-PRIOR', acceptance_tests: ['t1'] }];
    const v = await runExitGate(makeResult(['src/x.ts', 'a.ts']), CONTRACT, {
      validator: () => ({ ok: true, errors: [] }),
      regression: { prior, runner },
      assessor: async () => ({ ok: true, errors: [] }),
    });
    expect(v.accepted).toBe(true);
    expect(v.stages.every((s) => s.ok)).toBe(true);
    expect(assertWriteSetInvariant(v).ok).toBe(true);
  });

  // ── invariant_all_changes_pass_writeset_zero_exceptions ──
  it('invariant_all_changes_pass_writeset_zero_exceptions: accepted ⟺ every change in write-set', async () => {
    // a battery of diffs, including adversarial out-of-set + mixed sets
    const scenarios: { files: string[]; claimed?: string[] }[] = [
      { files: ['src/a.ts'] },
      { files: ['src/a.ts', 'src/deep/b.ts', 'a.ts'] },
      { files: ['a.ts'] },
      { files: ['evil.ts'] },
      { files: ['src/ok.ts', 'evil.ts'] },                         // one bad among good
      { files: ['../escape.ts'] },
      { files: ['secret.ts'], claimed: ['src/a.ts'] },             // lying self-report
      { files: ['src/x.ts', 'b.ts'] },                             // b.ts not in set
      { files: ['package.json'] },
      { files: ['src/x.ts', 'src/y.ts', 'src/z.ts'] },
    ];

    const gates = {
      validator: () => ({ ok: true, errors: [] }),
      assessor: async () => ({ ok: true, errors: [] }),
    };

    for (const sc of scenarios) {
      const v = await runExitGate(makeResult(sc.files, { claimed: sc.claimed }), CONTRACT, gates);

      // THE INVARIANT — zero exceptions, every run:
      // if accepted, the out-of-write-set set is EMPTY.
      expect(assertWriteSetInvariant(v).ok).toBe(true);
      if (v.accepted) {
        expect(v.out_of_write_set).toEqual([]);
        // and every changed file matches the write-set
        for (const f of v.changed_files) {
          expect(f === 'a.ts' || f.startsWith('src/')).toBe(true);
        }
      } else {
        // rejection is the ONLY outcome when anything is out of bounds
        // (or a downstream gate failed — but here downstream gates all pass)
        // so a non-accepted run here must have had an out-of-set change.
        if (v.rejected_whole) expect(v.out_of_write_set.length).toBeGreaterThan(0);
      }
    }
  });
});
