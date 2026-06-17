/**
 * STORY — Developer pre-submit Observe loop (the ReAct Observe step).
 *
 * Proves the agent-level loop: produce → OBSERVE (apply + run affected tests) →
 * red ⇒ feed the red tests back and self-correct (bounded) → green ⇒ submit.
 *
 * The 病根 scenario: the Developer's FIRST patch is a `modify` that drops an earlier
 * story's in-file behaviour (S2). The three static gates (write-set / no-self-tests /
 * additive=no-delete) all pass it — a `modify` is not a delete. Only Observe, which
 * runs S2's test, sees the red and forces a correction. Here `observe` models exactly
 * what executePreflight returns by inspecting whether the patch preserved S2's marker;
 * the genuine real-fs/`node --test` proof lives in preflight-runner/observe.test.ts.
 * CI-safe: scripted provider + scripted observation, no model, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  runDeveloperObserveLoop,
  assertDeveloperObservedBeforeEmit,
  type PatchProposal,
  type ProducePatchProposalResult,
  type PreflightObservation,
  type DeveloperObserveDeps,
} from './index';

const S2_MARKER = '[S2:v2]';

/** Build a minimal patch proposal whose edit carries (or drops) the S2 behaviour. */
function proposalWithGreet(body: string): PatchProposal {
  return {
    proposal_id: 'PP-S3-001', story_id: 'S3', contract_id: 'story_contract:S3', contract_version: 1,
    summary: 'implement S3', change_type: 'new_impl', changed_files: ['s2.mjs'],
    patch_branch: 'story/S3', postconditions_claimed: [], proposed_at: '2026-06-17T00:00:00Z',
    status: 'proposed',
    edits: [{ path: 's2.mjs', operation: 'modify', rationale: body }],
    rationale_summary: body, rollback_notes: 'revert s2.mjs', additive: true, reversible: true,
  };
}

/** A scripted observation that mirrors executePreflight: S2's test passes iff the
 *  patch preserved the S2 marker; otherwise it goes red and names the test. */
function observeByMarker(preserved: boolean): PreflightObservation {
  return preserved
    ? { passed: true, failing_tests: [], executed: true, typecheck_ok: true }
    : { passed: false, failing_tests: ['greet keeps the [S2:v2] behaviour'], executed: true, typecheck_ok: true };
}

describe('runDeveloperObserveLoop — bounded self-correction', () => {
  it('first patch DROPS S2 (red) → self-corrects → submits the preserving patch', async () => {
    const trace: Array<{ attempt: number; passed: boolean; verdict: string }> = [];
    const deps: DeveloperObserveDeps = {
      developerProvider: (feedback): ProducePatchProposalResult => {
        // Turn 0: buggy patch that drops the S2 marker. Turn 1+: corrected, preserves it.
        const preserved = feedback !== null;
        const body = preserved ? `greet keeps ${S2_MARKER}` : 'greet drops S2 behaviour';
        return { ok: true, proposal: proposalWithGreet(body), errors: [], rejected_paths: [] };
      },
      observe: (proposal) => observeByMarker(proposal.edits[0].rationale!.includes(S2_MARKER)),
      trace: (e) => trace.push({ attempt: e.attempt, passed: e.passed, verdict: e.verdict }),
    };

    const result = await runDeveloperObserveLoop(deps);

    expect(result.kind).toBe('submit');
    if (result.kind === 'submit') {
      expect(result.observed).toBe(true);              // structurally observed before emit
      expect(result.attempts).toBe(1);                 // exactly one self-correction
      expect(result.proposal.edits[0].rationale).toContain(S2_MARKER);
    }
    // Round 0 was red (deletion observed), round 1 green.
    expect(trace[0]).toMatchObject({ attempt: 0, passed: false, verdict: 'self_correct' });
    expect(trace[1]).toMatchObject({ attempt: 1, passed: true, verdict: 'submit' });
  });

  it('a green first patch submits with no unnecessary self-correction', async () => {
    const deps: DeveloperObserveDeps = {
      developerProvider: () => ({ ok: true, proposal: proposalWithGreet(`greet keeps ${S2_MARKER}`), errors: [], rejected_paths: [] }),
      observe: (proposal) => observeByMarker(proposal.edits[0].rationale!.includes(S2_MARKER)),
    };
    const result = await runDeveloperObserveLoop(deps);
    expect(result.kind).toBe('submit');
    if (result.kind === 'submit') expect(result.attempts).toBe(0);
  });

  it('a developer that KEEPS dropping S2 escalates after the budget — never loops', async () => {
    let rounds = 0;
    const deps: DeveloperObserveDeps = {
      developerProvider: () => { rounds++; return { ok: true, proposal: proposalWithGreet('still dropping S2'), errors: [], rejected_paths: [] }; },
      observe: () => observeByMarker(false),  // always red
      maxSelfCorrections: 2,
    };
    const result = await runDeveloperObserveLoop(deps);
    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') {
      expect(result.observed).toBe(true);
      expect(result.attempts).toBe(2);                 // bounded at 2 self-corrections
      expect(result.reason).toMatch(/still red after 2/);
    }
    expect(rounds).toBe(3);                             // initial + 2 corrections, then stop
  });

  it('a provider that yields no proposal escalates without claiming observation', async () => {
    const deps: DeveloperObserveDeps = {
      developerProvider: () => ({ ok: false, proposal: undefined, errors: ['no output'], rejected_paths: [] }),
      observe: () => observeByMarker(true),
    };
    const result = await runDeveloperObserveLoop(deps);
    expect(result.kind).toBe('escalated');
    if (result.kind === 'escalated') expect(result.observed).toBe(false);
  });
});

describe('assertDeveloperObservedBeforeEmit — emit invariant', () => {
  it('throws when no preflight ran (the S2-deletion failure mode)', () => {
    expect(() => assertDeveloperObservedBeforeEmit({ proposalId: 'PP-1', preflight: null }))
      .toThrow(/developer_emit_without_observe/);
    expect(() => assertDeveloperObservedBeforeEmit({ proposalId: 'PP-1', preflight: { executed: false } }))
      .toThrow(/developer_emit_without_observe/);
  });

  it('throws when preflight ran but did not pass', () => {
    expect(() => assertDeveloperObservedBeforeEmit({ proposalId: 'PP-1', preflight: { executed: true, passed: false } }))
      .toThrow(/developer_emit_with_failed_preflight/);
  });

  it('passes only when a real preflight ran and passed', () => {
    expect(() => assertDeveloperObservedBeforeEmit({ proposalId: 'PP-1', preflight: { executed: true, passed: true } }))
      .not.toThrow();
  });
});
