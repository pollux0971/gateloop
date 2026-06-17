import { describe, it, expect } from 'vitest';
import {
  decideNextAction,
  validateStoryReady,
  SupervisorState,
  composeDeveloperTaskPacket,
  composeDebuggerTaskPacket,
  summarizeProgress,
  taskPacketEnvelopeErrors,
  DEFAULT_DEVELOPER_OUTPUT_REQUIRED,
  type StoryContractForPacket,
  type DeveloperPacketInput,
  type DebuggerPacketInput,
  type ProgressCycleInput,
} from './index';

const S = (o: Partial<SupervisorState>): SupervisorState => ({
  storyReady: true, sameSignatureCount: 0, attempts: { developer: 0, debugger: 0 },
  budget: { developer: 2, debugger: 2, sameSignature: 2 }, ...o,
});

describe('supervisor-runtime', () => {
  it('not_ready_story_routes_replan', () => expect(decideNextAction(S({ storyReady: false })).type).toBe('replan'));
  it('ready_story_no_result_calls_developer', () => expect(decideNextAction(S({})).type).toBe('call_developer'));
  it('developer_result_routes_validate', () => expect(decideNextAction(S({ developerResult: { patchProposal: true } })).type).toBe('validate'));
  it('validation_passed_routes_checkpoint', () => expect(decideNextAction(S({ validationReport: { status: 'passed' } })).type).toBe('checkpoint'));
  it('validation_failed_routes_debugger', () => expect(decideNextAction(S({ validationReport: { status: 'failed', failureType: 'test' } })).type).toBe('call_debugger'));
  it('repeated_signature_routes_human', () => expect(decideNextAction(S({ validationReport: { status: 'failed' }, sameSignatureCount: 2 })).type).toBe('ask_human'));
  it('budget_exhausted_routes_human', () => expect(decideNextAction(S({ validationReport: { status: 'failed' }, attempts: { developer: 2, debugger: 2 } })).type).toBe('ask_human'));
  it('permission_denied_routes_abort_attempt', () => expect(decideNextAction(S({ permissionDenied: {} })).type).toBe('abort_attempt'));
  it('permission_denied_scope_routes_human', () => expect(decideNextAction(S({ permissionDenied: { needsScopeExpansion: true } })).type).toBe('ask_human'));
  it('debugger_scope_expansion_routes_human', () => expect(decideNextAction(S({ debuggerResult: { withinScope: false, needsScopeExpansion: true } })).type).toBe('ask_human'));
  it('debugger_within_scope_routes_validate', () => expect(decideNextAction(S({ debuggerResult: { withinScope: true } })).type).toBe('validate'));
  it('security_human_issue_routes_human', () => expect(decideNextAction(S({ humanIssue: { severity: 'high', klass: 'security' } })).type).toBe('ask_human'));
  it('nonsecurity_human_issue_routes_debugger_investigation', () => expect(decideNextAction(S({ humanIssue: { severity: 'medium' } })).type).toBe('call_debugger'));
  it('validate_story_ready_flags_missing_fields', () => expect(validateStoryReady({ objective: 'x' }).length).toBeGreaterThan(0));
  it('validate_story_ready_empty_for_complete_contract', () => expect(validateStoryReady({
    objective: 'x', allowed_write_set: ['a'], acceptance_criteria: ['c'], validation_commands: ['v'], rollback_notes: 'r',
  }).length).toBe(0));
});

// ── STORY-029.2 — composeDeveloperTaskPacket ─────────────────────────────────

const CONTRACT: StoryContractForPacket = {
  story_id: 'STORY-042.1',
  objective: 'Add a rate limiter to the public API',
  allowed_write_set: ['gateloop/packages/api/src/'],
  forbidden_actions: ['no reading secrets', 'no sudo'],
  acceptance_criteria: ['limiter_rejects_over_quota', 'limiter_allows_under_quota'],
  validation_commands: ['pnpm test api', 'pnpm typecheck'],
  rollback_notes: 'revert api/src/rate-limiter.ts',
};

const INPUT = (o: Partial<DeveloperPacketInput> = {}): DeveloperPacketInput => ({ contract: CONTRACT, ...o });

describe('STORY-029.2 composeDeveloperTaskPacket', () => {
  it('developer_task_packet_composed_from_contract: renders all schema-required fields, deterministically', () => {
    const p = composeDeveloperTaskPacket(INPUT());
    // top-level required (task_packet.schema.json)
    for (const k of ['packet_id', 'story_id', 'story_contract_ref', 'target_agent', 'context_packet', 'output_required'])
      expect(p).toHaveProperty(k);
    // developer-branch required
    for (const k of ['task_title', 'task_goal', 'allowed_write_set', 'forbidden_actions', 'validation_commands', 'acceptance_criteria', 'rollback_requirement'])
      expect(p).toHaveProperty(k);
    expect(p.target_agent).toBe('developer');
    expect(p.story_id).toBe('STORY-042.1');
    expect(p.packet_id).toBe('TP-STORY-042.1');
    expect(p.context_packet).toHaveProperty('include_refs');
    expect(p.context_packet).toHaveProperty('exclude_patterns');
    expect(p.output_required).toEqual(DEFAULT_DEVELOPER_OUTPUT_REQUIRED);
    expect(p.rollback_requirement.required).toBe(true);
    // deterministic: same input → identical packet
    expect(composeDeveloperTaskPacket(INPUT())).toEqual(p);
  });

  it('includes_writeset_acceptance_context: write-set + acceptance copied from contract, context refs threaded in', () => {
    const p = composeDeveloperTaskPacket(INPUT({ contextRefs: ['codegraph:api/rate-limiter', 'schema:api_quota'] }));
    expect(p.allowed_write_set).toEqual(['gateloop/packages/api/src/']);
    expect(p.acceptance_criteria).toEqual(['limiter_rejects_over_quota', 'limiter_allows_under_quota']);
    expect(p.validation_commands).toEqual(['pnpm test api', 'pnpm typecheck']);
    // context section refs (008.2) present alongside the contract ref
    expect(p.context_packet.include_refs).toContain('story_contract:STORY-042.1');
    expect(p.context_packet.include_refs).toContain('codegraph:api/rate-limiter');
    expect(p.context_packet.include_refs).toContain('schema:api_quota');
    // exclusions keep secrets/logs out of the packet
    expect(p.context_packet.exclude_patterns.length).toBeGreaterThan(0);
  });

  it('includes_failure_bank_warnings: matching AVOID warnings rendered into background and referenced', () => {
    const p = composeDeveloperTaskPacket(INPUT({
      failureWarnings: [
        { matching_signal: 'type:test|cmd:pnpm test api', avoid: 'Do not mock the limiter clock; use injectable now()', consolidated_count: 3 },
      ],
    }));
    const blob = JSON.stringify(p);
    expect(blob).toContain('Do not mock the limiter clock');           // operative AVOID text present
    expect(p.task_details.background).toContain('AVOID:');
    expect(p.task_details.background).toContain('recurring');           // consolidated_count >= 2
    expect(p.context_packet.include_refs).toContain('failure-bank:avoid:type:test|cmd:pnpm test api');
  });

  it('stub_removed: a valid contract yields a packet instead of throwing not-implemented', () => {
    expect(() => composeDeveloperTaskPacket(INPUT())).not.toThrow();
  });

  it('guard: an incomplete contract throws a clear (non-stub) error naming the missing fields', () => {
    const bad: StoryContractForPacket = { story_id: 'STORY-1', objective: 'x' }; // no write-set/acceptance/validation/rollback
    expect(() => composeDeveloperTaskPacket({ contract: bad })).toThrow(/missing required fields/);
    expect(() => composeDeveloperTaskPacket({ contract: bad })).not.toThrow(/not implemented/);
  });

  it('include_refs are de-duplicated and start with the contract ref', () => {
    const p = composeDeveloperTaskPacket(INPUT({ contextRefs: ['story_contract:STORY-042.1', 'dup', 'dup'] }));
    expect(p.context_packet.include_refs[0]).toBe('story_contract:STORY-042.1');
    expect(p.context_packet.include_refs.filter(r => r === 'dup')).toHaveLength(1);
  });
});

// ── STORY-029.4 — composeDebuggerTaskPacket ──────────────────────────────────

const DBG_INPUT = (o: Partial<DebuggerPacketInput> = {}): DebuggerPacketInput => ({
  contract: CONTRACT,
  failure: {
    failed_command: 'pnpm test api',
    failure_signature: 'type:test|cmd:pnpm test api|assert:over-quota',
    validation_report_ref: 'trace:vr-77',
    failed_acceptance: ['limiter_rejects_over_quota'],
  },
  diff: { changed_files: ['gateloop/packages/api/src/rate-limiter.ts'], current_patch_ref: 'pp-001' },
  ...o,
});

describe('STORY-029.4 composeDebuggerTaskPacket', () => {
  it('debugger_task_packet_composed: renders all schema-required debugger fields', () => {
    const p = composeDebuggerTaskPacket(DBG_INPUT());
    for (const k of ['packet_id', 'story_id', 'story_contract_ref', 'target_agent', 'context_packet', 'output_required'])
      expect(p).toHaveProperty(k);
    for (const k of ['debug_goal', 'failure_context', 'allowed_repair_scope'])
      expect(p).toHaveProperty(k);
    expect(p.target_agent).toBe('debugger');
    expect(p.story_id).toBe('STORY-042.1');
    expect(p.packet_id).toBe('TP-DBG-STORY-042.1');
    // deterministic
    expect(composeDebuggerTaskPacket(DBG_INPUT())).toEqual(p);
  });

  it('includes_gene_diff_acceptance_guardrails: gene, local diff, failed acceptance, and guardrails all present', () => {
    const p = composeDebuggerTaskPacket(DBG_INPUT({
      gene: { matching_signal: 'type:test|cmd:pnpm test api', avoid: 'Do not mock the clock; inject now()', consolidated_count: 2 },
    }));
    // failure gene
    expect(p.failure_gene).not.toBeNull();
    expect(p.failure_gene!.avoid).toContain('inject now()');
    expect(p.context_packet.include_refs).toContain('failure-bank:avoid:type:test|cmd:pnpm test api');
    // local diff under repair
    expect(p.failure_context.changed_files).toEqual(['gateloop/packages/api/src/rate-limiter.ts']);
    expect(p.failure_context.failure_signature).toBe('type:test|cmd:pnpm test api|assert:over-quota');
    // acceptance that failed
    expect(p.acceptance_that_failed).toEqual(['limiter_rejects_over_quota']);
    // do-not-touch guardrails
    expect(p.do_not_touch.some(g => /outside allowed_repair_scope/.test(g))).toBe(true);
    expect(p.forbidden_actions.some(g => /do not delete or weaken existing tests/.test(g))).toBe(true);
  });

  it('local_scope_only: repair scope is confined to the failing diff and widening is forbidden', () => {
    const p = composeDebuggerTaskPacket(DBG_INPUT());
    expect(p.allowed_repair_scope).toEqual(['gateloop/packages/api/src/rate-limiter.ts']);
    expect(p.forbidden_actions.some(g => /do not widen/i.test(g))).toBe(true);
    // empty diff falls back to the story's own write-set — never wider than the story
    const fallback = composeDebuggerTaskPacket(DBG_INPUT({ diff: { changed_files: [] } }));
    expect(fallback.allowed_repair_scope).toEqual(CONTRACT.allowed_write_set);
  });

  it('investigation_only intake: goal is reproduce-only, flag set', () => {
    const p = composeDebuggerTaskPacket(DBG_INPUT({ investigationOnly: true }));
    expect(p.investigation_only).toBe(true);
    expect(p.debug_goal).toMatch(/no repair until/i);
  });

  it('stub_removed: a valid failure yields a packet instead of throwing not-implemented', () => {
    expect(() => composeDebuggerTaskPacket(DBG_INPUT())).not.toThrow();
  });
});

// ── STORY-029.6 — summarizeProgress ──────────────────────────────────────────

const CYCLE = (o: Partial<ProgressCycleInput> = {}): ProgressCycleInput => ({
  story_id: 'STORY-042.1',
  epic_id: 'EPIC-042',
  attempt: 2,
  attempt_budget: 3,
  validation_result: 'fail',
  status: 'debugging',
  next_action: 'call_debugger',
  ...o,
});

describe('STORY-029.6 summarizeProgress', () => {
  it('progress_summarized_each_cycle: compact summary with story, attempt, validation, next action', () => {
    const s = summarizeProgress(CYCLE());
    expect(s.story_id).toBe('STORY-042.1');
    expect(s.attempt).toBe(2);
    expect(s.attempt_budget).toBe(3);
    expect(s.validation_result).toBe('fail');
    expect(s.next_action).toBe('call_debugger');
    expect(s.summary).toContain('STORY-042.1');
    expect(s.summary).toContain('attempt 2/3');
    expect(s.summary).toContain('call_debugger');
    // deterministic
    expect(summarizeProgress(CYCLE())).toEqual(s);
  });

  it('summary_recorded_in_trace: returns a well-formed trace event', () => {
    const s = summarizeProgress(CYCLE());
    expect(s.event_type).toBe('progress_summary');
    for (const k of ['story_id', 'attempt', 'validation_result', 'next_action', 'summary'])
      expect(s).toHaveProperty(k);
  });

  it('no_raw_transcript_leakage: raw transcript / logs / secrets never appear in the summary', () => {
    const s = summarizeProgress(CYCLE({
      // these extra fields exist on the tracker cycle but must NOT be copied:
      raw_transcript: 'SECRET TRANSCRIPT: user said the password is hunter2',
      logs: 'line1\nline2\n...huge log...',
      api_key: 'sk-abcdef0123456789',
    } as Partial<ProgressCycleInput>));
    const blob = JSON.stringify(s);
    expect(blob).not.toContain('SECRET TRANSCRIPT');
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('huge log');
    expect(blob).not.toContain('sk-abcdef0123456789');
  });

  it('no_raw_transcript_leakage: a secret embedded in a surfaced field is redacted', () => {
    const s = summarizeProgress(CYCLE({ next_action: 'retry with token=sk-deadbeef12345678 set' }));
    expect(s.next_action).toContain('[REDACTED]');
    expect(s.summary).not.toContain('sk-deadbeef12345678');
  });

  it('stub_removed: a valid cycle yields a summary instead of throwing not-implemented', () => {
    expect(() => summarizeProgress(CYCLE())).not.toThrow();
  });
});

// ── STORY-032.1 — composed packets conform to their JSON envelope ──────────────

describe('STORY-032.1 composed packets are envelope-valid', () => {
  it('developer task packet conforms to developer_task_packet envelope', () => {
    const p = composeDeveloperTaskPacket(INPUT());
    expect(taskPacketEnvelopeErrors(p as unknown as Record<string, unknown>, 'developer_task_packet')).toEqual([]);
  });

  it('debugger task packet conforms to debugger_task_packet envelope', () => {
    const p = composeDebuggerTaskPacket(DBG_INPUT());
    expect(taskPacketEnvelopeErrors(p as unknown as Record<string, unknown>, 'debugger_task_packet')).toEqual([]);
  });

  it('a packet missing a required envelope field is flagged', () => {
    const p = composeDeveloperTaskPacket(INPUT()) as unknown as Record<string, unknown>;
    delete p.allowed_write_set;
    expect(taskPacketEnvelopeErrors(p, 'developer_task_packet')).toContain('missing required envelope field: allowed_write_set');
  });
});
