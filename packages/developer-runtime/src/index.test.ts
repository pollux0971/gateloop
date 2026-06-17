import { describe, it, expect } from 'vitest';
import {
  validateDeveloperOutput,
  changedFilesWithinWriteSet,
  producePatchProposal,
  acceptanceTestPathsFromPacket,
  developerReadableTests,
  rejectDeveloperAuthoredAcceptanceTests,
  type DeveloperTaskPacketView,
  type AcceptanceTestRef,
} from './index';
import {
  ProviderRegistry,
  createScriptedProvider,
  type RoutingConfig,
  type AgentStructuredOutput,
} from '@gateloop/model-gateway';
import type { AskModelDeps } from '@gateloop/agent-core';

const fullOutput = {
  implementation_plan: 'p', patch_proposal: {}, changed_files: ['a.ts'],
  test_plan: 't', risk_notes: 'r', rollback_notes: 'rb',
};
describe('developer-runtime', () => {
  it('valid_developer_output_passes', () => expect(validateDeveloperOutput(fullOutput).ok).toBe(true));
  it('missing_rollback_notes_fails', () => { const { rollback_notes, ...rest } = fullOutput; expect(validateDeveloperOutput(rest).ok).toBe(false); });
  it('changed_files_within_write_set_passes', () => expect(changedFilesWithinWriteSet(['pkg/src/a.ts'], ['pkg/src/**']).ok).toBe(true));
  it('changed_files_outside_write_set_fails', () => expect(changedFilesWithinWriteSet(['other/x.ts'], ['pkg/src/**']).ok).toBe(false));
});

// ── STORY-029.3 — producePatchProposal (the critical joint) ──────────────────

const PACKET: DeveloperTaskPacketView = {
  story_id: 'STORY-042.1',
  story_contract_ref: 'story_contract:STORY-042.1',
  contract_version: 1,
  allowed_write_set: ['gateloop/packages/api/src/**'],
  acceptance_criteria: ['limiter_rejects_over_quota'],
};

const ROUTING: RoutingConfig = { agents: { developer: { primary: 'scripted-dev' } } };
const FIXED = '2026-06-14T00:00:00.000Z';

function depsReturning(output: AgentStructuredOutput): AskModelDeps {
  const registry = new ProviderRegistry();
  registry.register(
    createScriptedProvider('scripted-dev', [{ case_id: 'dev', match: { target_agent: 'developer' }, output }]),
  );
  return { registry, routing: ROUTING };
}

const VALID_OUTPUT = {
  kind: 'patch_proposal',
  proposal_id: 'PP-STORY-042.1-001',
  story_id: 'STORY-042.1',
  summary: 'Add an injectable-clock token-bucket rate limiter',
  change_type: 'new_impl',
  changed_files: ['gateloop/packages/api/src/rate-limiter.ts'],
  edits: [{ path: 'gateloop/packages/api/src/rate-limiter.ts', operation: 'create' }],
  rationale_summary: 'Introduces a token bucket with injectable now() so the limiter is testable.',
  rollback_notes: 'delete gateloop/packages/api/src/rate-limiter.ts',
} as AgentStructuredOutput;

describe('STORY-029.3 producePatchProposal', () => {
  it('patch_proposal_produced_from_packet: scripted provider yields a schema-conforming, deterministic proposal', async () => {
    const deps = depsReturning(VALID_OUTPUT);
    const r = await producePatchProposal(PACKET, deps, { proposedAt: FIXED });
    expect(r.ok).toBe(true);
    const p = r.proposal!;
    for (const k of ['proposal_id', 'story_id', 'contract_id', 'contract_version', 'summary', 'change_type', 'changed_files', 'patch_branch', 'postconditions_claimed', 'proposed_at', 'status'])
      expect(p).toHaveProperty(k);
    expect(p.status).toBe('proposed');
    expect(p.story_id).toBe('STORY-042.1');
    expect(p.contract_id).toBe('story_contract:STORY-042.1');
    expect(p.patch_branch).toBe('story/STORY-042.1');
    expect(p.patch_branch).not.toBe('main');
    expect(p.postconditions_claimed).toEqual(['limiter_rejects_over_quota']);
    // self-described rationale attached
    expect(p.rationale_summary).toContain('token bucket');
    // deterministic given the same packet + provider output + injected timestamp
    const r2 = await producePatchProposal(PACKET, depsReturning(VALID_OUTPUT), { proposedAt: FIXED });
    expect(r2.proposal).toEqual(p);
  });

  it('edits_outside_writeset_rejected_pre_emit: an out-of-write-set edit is rejected, no proposal emitted', async () => {
    const leaky = {
      ...VALID_OUTPUT,
      changed_files: ['gateloop/packages/api/src/rate-limiter.ts', 'gateloop/packages/billing/src/charge.ts'],
      edits: [
        { path: 'gateloop/packages/api/src/rate-limiter.ts', operation: 'create' },
        { path: 'gateloop/packages/billing/src/charge.ts', operation: 'modify' },
      ],
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET, depsReturning(leaky), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.proposal).toBeUndefined();
    expect(r.rejected_paths).toContain('gateloop/packages/billing/src/charge.ts');
    expect(r.errors.join(' ')).toContain('outside write-set');
  });

  it('proposal_additive_and_reversible: a clean proposal is flagged additive + reversible', async () => {
    const r = await producePatchProposal(PACKET, depsReturning(VALID_OUTPUT), { proposedAt: FIXED });
    expect(r.ok).toBe(true);
    expect(r.proposal!.additive).toBe(true);
    expect(r.proposal!.reversible).toBe(true);
    expect(r.proposal!.rollback_notes.length).toBeGreaterThan(0);
  });

  it('proposal_additive_and_reversible: a delete edit is rejected as non-additive', async () => {
    const destructive = {
      ...VALID_OUTPUT,
      edits: [{ path: 'gateloop/packages/api/src/rate-limiter.ts', operation: 'delete' }],
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET, depsReturning(destructive), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('not additive');
  });

  it('proposal_additive_and_reversible: a proposal without rollback notes is rejected as irreversible', async () => {
    const { rollback_notes, ...noRollback } = VALID_OUTPUT as Record<string, unknown>;
    const r = await producePatchProposal(PACKET, depsReturning(noRollback as AgentStructuredOutput), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('not reversible');
  });

  it('stub_removed: producePatchProposal resolves a result instead of throwing not-implemented', async () => {
    const r = await producePatchProposal(PACKET, depsReturning(VALID_OUTPUT), { proposedAt: FIXED });
    expect(r).toHaveProperty('ok', true);
  });

  it('non-patch model output (escalation) is surfaced, not treated as a patch', async () => {
    const blocked = {
      kind: 'blocked_report',
      type: 'blocked_by_missing_context',
      reason: 'need the quota config',
      requested_decision: 'provide_quota_config',
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET, depsReturning(blocked), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.escalation).toBeDefined();
    expect(r.errors.join(' ')).toContain('did not produce a patch');
  });
});

// ── STORY-030.2: Developer must not author its own acceptance tests ────────────

describe('STORY-030.2 developer acceptance-test boundary', () => {
  // acceptance test lives INSIDE the write-set glob — so the write-set gate would
  // pass; only the acceptance-test gate must reject writing it.
  const ACCEPTANCE_PATH = 'gateloop/packages/api/src/__acceptance__/limiter.acceptance.test.ts';
  const ACCEPTANCE_TESTS: AcceptanceTestRef[] = [
    { path: ACCEPTANCE_PATH, content: 'test("limiter_rejects_over_quota", () => {/* by assessor */})', source: 'assessor' },
  ];
  const PACKET_WITH_TESTS: DeveloperTaskPacketView = {
    ...PACKET,
    acceptance_tests: ACCEPTANCE_TESTS,
  };

  it('acceptance_tests_provided_in_packet', () => {
    expect(developerReadableTests(PACKET_WITH_TESTS)).toHaveLength(1);
    expect(developerReadableTests(PACKET_WITH_TESTS)[0].source).toBe('assessor');
    expect(acceptanceTestPathsFromPacket(PACKET_WITH_TESTS)).toContain(ACCEPTANCE_PATH);
  });

  it('developer_may_still_read_tests', async () => {
    // A proposal that does NOT touch the acceptance tests still succeeds even
    // though acceptance_tests are present in the packet — reading is allowed.
    const r = await producePatchProposal(PACKET_WITH_TESTS, depsReturning(VALID_OUTPUT), { proposedAt: FIXED });
    expect(r.ok).toBe(true);
    expect(r.proposal!.changed_files).not.toContain(ACCEPTANCE_PATH);
  });

  it('developer_cannot_author_own_acceptance_tests', async () => {
    const authoringTests = {
      ...VALID_OUTPUT,
      changed_files: ['gateloop/packages/api/src/rate-limiter.ts', ACCEPTANCE_PATH],
      edits: [
        { path: 'gateloop/packages/api/src/rate-limiter.ts', operation: 'create' },
        { path: ACCEPTANCE_PATH, operation: 'create' },
      ],
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET_WITH_TESTS, depsReturning(authoringTests), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.proposal).toBeUndefined();
    expect(r.errors.join(' ')).toContain('developer_cannot_author_own_acceptance_tests');
  });

  it('patch_touching_own_acceptance_tests_rejected', async () => {
    // pre-emit gate (unit) — direct
    const gate = rejectDeveloperAuthoredAcceptanceTests(
      ['gateloop/packages/api/src/rate-limiter.ts', ACCEPTANCE_PATH],
      [ACCEPTANCE_PATH],
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors.join(' ')).toContain(ACCEPTANCE_PATH);
    // and end-to-end the rejected path is surfaced
    const modifying = {
      ...VALID_OUTPUT,
      changed_files: [ACCEPTANCE_PATH],
      edits: [{ path: ACCEPTANCE_PATH, operation: 'modify' }],
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET_WITH_TESTS, depsReturning(modifying), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.rejected_paths).toContain(ACCEPTANCE_PATH);
  });
});
