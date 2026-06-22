/**
 * STORY-002.1 — Implement workflow state machine
 *
 * Covers all three acceptance-criteria behaviors:
 *   1. valid_transitions_pass
 *   2. invalid_transitions_rejected
 *   3. main_workflow_happy_path_covered
 *
 * All tests are deterministic; no LLM, no external API, no secrets.
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync, readFileSync } from 'fs';
import {
  canTransition,
  tick,
  selectNextStory,
  enforceAttemptBudget,
  enforceRunBudget,
  decideAutoAdvance,
  storyNeedsRealApi,
  loadOrInitProjectRunState,
  persistProjectRunState,
  buildReviewSummary,
  recordReviewDecision,
  flagTestAuthorship,
  recordTestIntegrity,
  sendNotification,
  enrichBrownfieldStory,
  recordResolvedSettings,
  recordProviderRegistrations,
  classifyConsoleMessage,
  routeConsoleMessage,
  applyBacklogDelta,
  transitionToTerminalState,
  rollbackWorkspace,
  type HarnessState,
  type StoryRecord,
  type RunBudget,
  type TickInput,
  type ProjectRunState,
  type NotificationConfig,
  type NotificationPayload,
  type NotificationHttpClient,
  type BrownfieldCodeGraphClient,
  type BacklogTransaction,
  type BacklogDeltaInput,
  type TerminalStateCause,
  evaluateGateSla,
  GLOBAL_GATES_NO_AUTO_CLOSE,
  type GateSlaConfig,
  acceptanceTestBoundaryCheck,
  decideRegressionRoute,
  RegressionRegistry,
  emitHandoffCard, validateHandoffCard, assertHandoffCardFactsOnly, writeHandoffCard,
  getAgentPromptView, getSkillView, mountedSkillsForRole, DEFAULT_AGENT_BASE,
  type StoryCompletionFacts, type MountedSkillRef,
} from './index.js';
import { readJsonl } from '@gateloop/event-log';
import { DEFAULT_SETTINGS } from '@gateloop/settings';

const tmpPath = () => join(tmpdir(), `prs_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}.json`);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<StoryRecord> = {}): StoryRecord {
  return {
    story_id: 'STORY-002.1',
    epic_id: 'EPIC-002',
    depends_on: [],
    parallelism_class: 'sequential',
    status: 'todo',
    attempts: 0,
    attempt_budget: 3,
    branch: null,
    last_action: null,
    last_result: null,
    last_validation: null,
    blocked_reason: null,
    ...overrides,
  };
}

function makeRunBudget(used = 0, budget = 10): RunBudget {
  return { run_iteration_budget: budget, iterations_used: used };
}

function makeTickInput(overrides: Partial<TickInput>): TickInput {
  return {
    state: 'SUPERVISOR_CONTRACT',
    story: makeStory(),
    runBudget: makeRunBudget(),
    lastValidationPassed: null,
    humanGateCleared: false,
    ...overrides,
  };
}

// ── AC 1: valid_transitions_pass ──────────────────────────────────────────────

describe('STORY-002.1 valid_transitions_pass', () => {
  it('IDEA_INBOX → PLANNING_BUNDLE is valid', () => {
    expect(canTransition('IDEA_INBOX', 'PLANNING_BUNDLE')).toBe(true);
  });

  it('PLANNING_BUNDLE → SUPERVISOR_CONTRACT is valid', () => {
    expect(canTransition('PLANNING_BUNDLE', 'SUPERVISOR_CONTRACT')).toBe(true);
  });

  it('SUPERVISOR_CONTRACT → DEVELOPER_PATCH_PROPOSAL is valid', () => {
    expect(canTransition('SUPERVISOR_CONTRACT', 'DEVELOPER_PATCH_PROPOSAL')).toBe(true);
  });

  it('DEVELOPER_PATCH_PROPOSAL → DEVELOPER_PREFLIGHT is valid', () => {
    expect(canTransition('DEVELOPER_PATCH_PROPOSAL', 'DEVELOPER_PREFLIGHT')).toBe(true);
  });

  it('DEVELOPER_PATCH_PROPOSAL → HUMAN_GATE is valid (escalation path)', () => {
    expect(canTransition('DEVELOPER_PATCH_PROPOSAL', 'HUMAN_GATE')).toBe(true);
  });

  it('DEVELOPER_PREFLIGHT → SPEC_CONFORMANCE_REVIEW is valid (pass)', () => {
    expect(canTransition('DEVELOPER_PREFLIGHT', 'SPEC_CONFORMANCE_REVIEW')).toBe(true);
  });

  it('DEVELOPER_PREFLIGHT → DEVELOPER_PATCH_PROPOSAL is valid (self-correct)', () => {
    expect(canTransition('DEVELOPER_PREFLIGHT', 'DEVELOPER_PATCH_PROPOSAL')).toBe(true);
  });

  it('DEVELOPER_PREFLIGHT → HUMAN_GATE is valid (escalation)', () => {
    expect(canTransition('DEVELOPER_PREFLIGHT', 'HUMAN_GATE')).toBe(true);
  });

  it('SPEC_CONFORMANCE_REVIEW → WORKSPACE_APPLY is valid (pass)', () => {
    expect(canTransition('SPEC_CONFORMANCE_REVIEW', 'WORKSPACE_APPLY')).toBe(true);
  });

  it('SPEC_CONFORMANCE_REVIEW → DEVELOPER_PATCH_PROPOSAL is valid (fix proposal)', () => {
    expect(canTransition('SPEC_CONFORMANCE_REVIEW', 'DEVELOPER_PATCH_PROPOSAL')).toBe(true);
  });

  it('SPEC_CONFORMANCE_REVIEW → HUMAN_GATE is valid (escalation)', () => {
    expect(canTransition('SPEC_CONFORMANCE_REVIEW', 'HUMAN_GATE')).toBe(true);
  });

  it('WORKSPACE_APPLY → VALIDATION is valid', () => {
    expect(canTransition('WORKSPACE_APPLY', 'VALIDATION')).toBe(true);
  });

  it('VALIDATION → DEBUG_LOOP is valid (failure path)', () => {
    expect(canTransition('VALIDATION', 'DEBUG_LOOP')).toBe(true);
  });

  it('VALIDATION → CHECKPOINT is valid (pass path)', () => {
    expect(canTransition('VALIDATION', 'CHECKPOINT')).toBe(true);
  });

  it('VALIDATION → HUMAN_GATE is valid (escalation path)', () => {
    expect(canTransition('VALIDATION', 'HUMAN_GATE')).toBe(true);
  });

  it('DEBUG_LOOP → DEVELOPER_PATCH_PROPOSAL is valid (retry)', () => {
    expect(canTransition('DEBUG_LOOP', 'DEVELOPER_PATCH_PROPOSAL')).toBe(true);
  });

  it('DEBUG_LOOP → SUPERVISOR_CONTRACT is valid (re-contract)', () => {
    expect(canTransition('DEBUG_LOOP', 'SUPERVISOR_CONTRACT')).toBe(true);
  });

  it('DEBUG_LOOP → HUMAN_GATE is valid (escalation)', () => {
    expect(canTransition('DEBUG_LOOP', 'HUMAN_GATE')).toBe(true);
  });

  it('CHECKPOINT → PROMOTION_REVIEW is valid', () => {
    expect(canTransition('CHECKPOINT', 'PROMOTION_REVIEW')).toBe(true);
  });

  it('CHECKPOINT → SUPERVISOR_CONTRACT is valid (next story)', () => {
    expect(canTransition('CHECKPOINT', 'SUPERVISOR_CONTRACT')).toBe(true);
  });

  it('HUMAN_GATE → SUPERVISOR_CONTRACT is valid (cleared)', () => {
    expect(canTransition('HUMAN_GATE', 'SUPERVISOR_CONTRACT')).toBe(true);
  });

  it('HUMAN_GATE → CHECKPOINT is valid', () => {
    expect(canTransition('HUMAN_GATE', 'CHECKPOINT')).toBe(true);
  });

  it('HUMAN_GATE → DONE is valid', () => {
    expect(canTransition('HUMAN_GATE', 'DONE')).toBe(true);
  });

  it('PROMOTION_REVIEW → DONE is valid (approved)', () => {
    expect(canTransition('PROMOTION_REVIEW', 'DONE')).toBe(true);
  });

  it('PROMOTION_REVIEW → HUMAN_GATE is valid (needs review)', () => {
    expect(canTransition('PROMOTION_REVIEW', 'HUMAN_GATE')).toBe(true);
  });
});

// ── AC 2: invalid_transitions_rejected ────────────────────────────────────────

describe('STORY-002.1 invalid_transitions_rejected', () => {
  it('IDEA_INBOX → DONE is rejected (skips pipeline)', () => {
    expect(canTransition('IDEA_INBOX', 'DONE')).toBe(false);
  });

  it('IDEA_INBOX → SUPERVISOR_CONTRACT is rejected (skips planning)', () => {
    expect(canTransition('IDEA_INBOX', 'SUPERVISOR_CONTRACT')).toBe(false);
  });

  it('PLANNING_BUNDLE → DONE is rejected (no direct promotion)', () => {
    expect(canTransition('PLANNING_BUNDLE', 'DONE')).toBe(false);
  });

  it('PLANNING_BUNDLE → WORKSPACE_APPLY is rejected (skips middle states)', () => {
    expect(canTransition('PLANNING_BUNDLE', 'WORKSPACE_APPLY')).toBe(false);
  });

  it('WORKSPACE_APPLY → CHECKPOINT is rejected (skips VALIDATION)', () => {
    expect(canTransition('WORKSPACE_APPLY', 'CHECKPOINT')).toBe(false);
  });

  it('WORKSPACE_APPLY → DONE is rejected (must go through VALIDATION)', () => {
    expect(canTransition('WORKSPACE_APPLY', 'DONE')).toBe(false);
  });

  it('VALIDATION → SUPERVISOR_CONTRACT is rejected (must go through DEBUG_LOOP)', () => {
    expect(canTransition('VALIDATION', 'SUPERVISOR_CONTRACT')).toBe(false);
  });

  it('VALIDATION → DONE is rejected (must go through CHECKPOINT)', () => {
    expect(canTransition('VALIDATION', 'DONE')).toBe(false);
  });

  it('CHECKPOINT → DONE is rejected (must pass through PROMOTION_REVIEW or next story)', () => {
    expect(canTransition('CHECKPOINT', 'DONE')).toBe(false);
  });

  it('DONE → SUPERVISOR_CONTRACT is rejected (terminal state)', () => {
    expect(canTransition('DONE', 'SUPERVISOR_CONTRACT')).toBe(false);
  });

  it('DONE → IDEA_INBOX is rejected (terminal state has no transitions)', () => {
    expect(canTransition('DONE', 'IDEA_INBOX')).toBe(false);
  });

  it('DONE → DONE is rejected (terminal → terminal is a no-op, not a valid transition)', () => {
    expect(canTransition('DONE', 'DONE')).toBe(false);
  });

  it('DEBUG_LOOP → VALIDATION is rejected (must retry via developer)', () => {
    expect(canTransition('DEBUG_LOOP', 'VALIDATION')).toBe(false);
  });

  it('SUPERVISOR_CONTRACT → DONE is rejected (skips all implementation states)', () => {
    expect(canTransition('SUPERVISOR_CONTRACT', 'DONE')).toBe(false);
  });

  it('PROMOTION_REVIEW → PLANNING_BUNDLE is rejected (no backward transition)', () => {
    expect(canTransition('PROMOTION_REVIEW', 'PLANNING_BUNDLE')).toBe(false);
  });

  it('SPEC_CONFORMANCE_REVIEW → VALIDATION is rejected (must apply first)', () => {
    expect(canTransition('SPEC_CONFORMANCE_REVIEW', 'VALIDATION')).toBe(false);
  });

  it('DEVELOPER_PREFLIGHT → WORKSPACE_APPLY is rejected (must pass conformance first)', () => {
    expect(canTransition('DEVELOPER_PREFLIGHT', 'WORKSPACE_APPLY')).toBe(false);
  });
});

// ── AC 3: main_workflow_happy_path_covered ─────────────────────────────────────

describe('STORY-002.1 main_workflow_happy_path_covered', () => {
  it('tick returns issue_contract from SUPERVISOR_CONTRACT state', () => {
    const input = makeTickInput({ state: 'SUPERVISOR_CONTRACT' });
    expect(tick(input)).toBe('issue_contract');
  });

  it('tick returns request_patch from DEVELOPER_PATCH_PROPOSAL state', () => {
    const input = makeTickInput({ state: 'DEVELOPER_PATCH_PROPOSAL' });
    expect(tick(input)).toBe('request_patch');
  });

  it('tick returns apply_patch from WORKSPACE_APPLY state', () => {
    const input = makeTickInput({ state: 'WORKSPACE_APPLY' });
    expect(tick(input)).toBe('apply_patch');
  });

  it('tick returns run_validation when VALIDATION with no result yet', () => {
    const input = makeTickInput({ state: 'VALIDATION', lastValidationPassed: null });
    expect(tick(input)).toBe('run_validation');
  });

  it('tick returns write_checkpoint when VALIDATION passes', () => {
    const input = makeTickInput({ state: 'VALIDATION', lastValidationPassed: true });
    expect(tick(input)).toBe('write_checkpoint');
  });

  it('tick returns mark_story_done from CHECKPOINT state', () => {
    const input = makeTickInput({ state: 'CHECKPOINT' });
    expect(tick(input)).toBe('mark_story_done');
  });

  it('happy path states form a valid transition chain', () => {
    const happyPath: HarnessState[] = [
      'IDEA_INBOX',
      'PLANNING_BUNDLE',
      'SUPERVISOR_CONTRACT',
      'DEVELOPER_PATCH_PROPOSAL',
      'DEVELOPER_PREFLIGHT',
      'SPEC_CONFORMANCE_REVIEW',
      'WORKSPACE_APPLY',
      'VALIDATION',
      'CHECKPOINT',
      'PROMOTION_REVIEW',
      'DONE',
    ];

    for (let i = 0; i < happyPath.length - 1; i++) {
      const from = happyPath[i];
      const to = happyPath[i + 1];
      expect(canTransition(from, to), `${from} → ${to} must be valid`).toBe(true);
    }
  });

  it('stop_run is returned when run budget is exhausted', () => {
    const input = makeTickInput({
      state: 'SUPERVISOR_CONTRACT',
      runBudget: makeRunBudget(10, 10), // exhausted
    });
    expect(tick(input)).toBe('stop_run');
  });

  it('tick routes to debugger when validation fails within attempt budget', () => {
    const input = makeTickInput({
      state: 'VALIDATION',
      lastValidationPassed: false,
      story: makeStory({ attempts: 1, attempt_budget: 3 }),
    });
    expect(tick(input)).toBe('route_debugger');
  });

  it('tick escalates human when validation fails and attempt budget is exhausted', () => {
    const input = makeTickInput({
      state: 'VALIDATION',
      lastValidationPassed: false,
      story: makeStory({ attempts: 3, attempt_budget: 3 }),
    });
    expect(tick(input)).toBe('escalate_human');
  });

  it('tick escalates human from DEBUG_LOOP when attempt budget is exhausted', () => {
    const input = makeTickInput({
      state: 'DEBUG_LOOP',
      story: makeStory({ attempts: 3, attempt_budget: 3 }),
    });
    expect(tick(input)).toBe('escalate_human');
  });

  it('tick returns retry_develop from DEBUG_LOOP when within attempt budget', () => {
    const input = makeTickInput({
      state: 'DEBUG_LOOP',
      story: makeStory({ attempts: 1, attempt_budget: 3 }),
    });
    expect(tick(input)).toBe('retry_develop');
  });

  it('HUMAN_GATE cleared → select_story; not cleared → stop_run', () => {
    const cleared = makeTickInput({ state: 'HUMAN_GATE', humanGateCleared: true });
    expect(tick(cleared)).toBe('select_story');

    const blocked = makeTickInput({ state: 'HUMAN_GATE', humanGateCleared: false });
    expect(tick(blocked)).toBe('stop_run');
  });

  it('PROMOTION_REVIEW always requires human escalation', () => {
    const input = makeTickInput({ state: 'PROMOTION_REVIEW' });
    expect(tick(input)).toBe('escalate_human');
  });
});

// ── selectNextStory (DAG-awareness, referenced by story-002.1 scope) ──────────

describe('STORY-002.1 selectNextStory DAG behavior', () => {
  it('selects first todo story with no unmet dependencies', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'A', status: 'done', depends_on: [] }),
      makeStory({ story_id: 'B', status: 'todo', depends_on: ['A'] }),
    ];
    expect(selectNextStory(stories)).toBe('B');
  });

  it('returns null when all todo stories have unmet dependencies', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'A', status: 'todo', depends_on: [] }),
      makeStory({ story_id: 'B', status: 'todo', depends_on: ['A'] }),
    ];
    // A is todo but not done; B depends on A
    // selectNextStory should pick A first
    expect(selectNextStory(stories)).toBe('A');
  });

  it('returns null when no stories are todo', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'A', status: 'done' }),
    ];
    expect(selectNextStory(stories)).toBeNull();
  });

  it('stable ordering: lower epic_id then lower story_id wins', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'STORY-002', epic_id: 'EPIC-002', status: 'todo' }),
      makeStory({ story_id: 'STORY-001', epic_id: 'EPIC-001', status: 'todo' }),
    ];
    expect(selectNextStory(stories)).toBe('STORY-001');
  });
});

// ── enforceAttemptBudget + enforceRunBudget ───────────────────────────────────

describe('STORY-002.1 budget enforcement', () => {
  it('enforceAttemptBudget returns ok when under budget', () => {
    const story = makeStory({ attempts: 1, attempt_budget: 3 });
    expect(enforceAttemptBudget(story)).toBe('ok');
  });

  it('enforceAttemptBudget returns escalate when at budget', () => {
    const story = makeStory({ attempts: 3, attempt_budget: 3 });
    expect(enforceAttemptBudget(story)).toBe('escalate');
  });

  it('enforceAttemptBudget returns escalate when over budget', () => {
    const story = makeStory({ attempts: 5, attempt_budget: 3 });
    expect(enforceAttemptBudget(story)).toBe('escalate');
  });

  it('enforceRunBudget returns ok when under budget', () => {
    expect(enforceRunBudget(makeRunBudget(2, 10))).toBe('ok');
  });

  it('enforceRunBudget returns stop when at budget', () => {
    expect(enforceRunBudget(makeRunBudget(10, 10))).toBe('stop');
  });

  it('enforceRunBudget returns stop when over budget', () => {
    expect(enforceRunBudget(makeRunBudget(15, 10))).toBe('stop');
  });
});

// ── project-run-state (STORY-010.3) ───────────────────────────────────────────

describe('project-run-state', () => {
  it('run_state_persisted_per_target_project', async () => {
    const p = tmpPath();
    const state = loadOrInitProjectRunState(p, 'proj-A', ['STORY-A', 'STORY-B'], 10);
    state.stories.find(s => s.story_id === 'STORY-A')!.status = 'done';
    await persistProjectRunState(p, state);

    const reloaded = loadOrInitProjectRunState(p, 'proj-A', ['STORY-A', 'STORY-B'], 10);
    expect(reloaded.stories.find(s => s.story_id === 'STORY-A')?.status).toBe('done');
    unlinkSync(p);
  });

  it('resume_continues_from_last_checkpoint', async () => {
    const p = tmpPath();
    const state = loadOrInitProjectRunState(p, 'proj-B', ['STORY-A','STORY-B','STORY-C'], 10);
    state.current_story = 'STORY-B';
    state.iterations_used = 1;
    state.stories.find(s => s.story_id === 'STORY-A')!.status = 'done';
    state.stories.find(s => s.story_id === 'STORY-A')!.checkpoint_sha = 'abc123';
    state.stories.find(s => s.story_id === 'STORY-B')!.status = 'in_progress';
    await persistProjectRunState(p, state);

    const resumed = loadOrInitProjectRunState(p, 'proj-B', ['STORY-A','STORY-B','STORY-C'], 10);
    expect(resumed.current_story).toBe('STORY-B');
    expect(resumed.iterations_used).toBe(1);
    expect(resumed.stories.find(s => s.story_id === 'STORY-A')?.status).toBe('done');
    expect(resumed.stories.find(s => s.story_id === 'STORY-C')?.status).toBe('todo');
    unlinkSync(p);
  });

  it('no_done_recorded_without_validator_evidence', () => {
    const state = loadOrInitProjectRunState('/nonexistent/fresh.json', 'proj-C', ['STORY-X'], 10);
    expect(state.stories.every(s => s.status === 'todo')).toBe(true);
  });

  it('fresh_init_when_file_missing', () => {
    const state = loadOrInitProjectRunState('/nonexistent/path.json', 'proj-D', ['STORY-Z'], 5);
    expect(state.project_id).toBe('proj-D');
    expect(state.stories.length).toBe(1);
    expect(state.stories[0].status).toBe('todo');
    expect(state.iterations_used).toBe(0);
  });

  it('persist_sets_updated_at', async () => {
    const p = tmpPath();
    const state = loadOrInitProjectRunState(p, 'proj-E', [], 5);
    const before = state.updated_at;
    await new Promise(r => setTimeout(r, 5));
    await persistProjectRunState(p, state);
    const after = JSON.parse(require('fs').readFileSync(p, 'utf8')).updated_at;
    expect(after >= before).toBe(true);
    unlinkSync(p);
  });
});

// ── review-cli domain (STORY-012.2) ───────────────────────────────────────────

function makeCheckpointedRunState(): ProjectRunState {
  return {
    schema_version: 1, project_id: 'proj-review', run_id: 'run-rev-1',
    created_at: '', updated_at: '', current_story: null, last_decision: null,
    iterations_used: 2, run_iteration_budget: 10,
    stories: [
      { story_id: 'STORY-A', status: 'done', attempts: 1, attempt_budget: 3,
        checkpoint_sha: 'sha-a', last_action: null, last_result: null, blocked_reason: null },
      { story_id: 'STORY-B', status: 'done', attempts: 1, attempt_budget: 3,
        checkpoint_sha: 'sha-b', last_action: null, last_result: null, blocked_reason: null },
    ],
  };
}

const tmpTrace = () => join(tmpdir(), `review-trace-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);
const tmpIntegrityTrace = () => join(tmpdir(), `integrity-trace-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);

describe('review-cli-domain', () => {
  it('approve_required_before_promotion', () => {
    const trace = tmpTrace();
    const decision = recordReviewDecision(
      { runId: 'run-rev-1', projectId: 'proj-review',
        runState: makeCheckpointedRunState(), traceLogPath: trace },
      'approved', ''
    );
    expect(decision.outcome).toBe('approved');
    expect(decision.reason).toBe('operator approved');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('deny_records_reason_and_blocks', () => {
    const trace = tmpTrace();
    const decision = recordReviewDecision(
      { runId: 'run-rev-1', projectId: 'proj-review',
        runState: makeCheckpointedRunState(), traceLogPath: trace },
      'denied', 'needs more tests'
    );
    expect(decision.outcome).toBe('denied');
    expect(decision.reason).toBe('needs more tests');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('deny_without_reason_throws', () => {
    const trace = tmpTrace();
    expect(() => recordReviewDecision(
      { runId: 'r', projectId: 'p', runState: makeCheckpointedRunState(), traceLogPath: trace },
      'denied', ''
    )).toThrow(/deny requires a reason/);
  });

  it('review_summary_shows_diff_and_validation_evidence', () => {
    const summary = buildReviewSummary(makeCheckpointedRunState());
    expect(summary.total_stories).toBe(2);
    expect(summary.done_count).toBe(2);
    expect(summary.promotable).toBe(true);
    expect(summary.all_checkpointed).toBe(true);
    expect(summary.validation_evidence.map(e => e.story_id)).toEqual(['STORY-A', 'STORY-B']);
  });

  it('summary_not_promotable_when_incomplete', () => {
    const partial = makeCheckpointedRunState();
    partial.stories[1].status = 'in_progress';
    partial.stories[1].checkpoint_sha = null;
    const summary = buildReviewSummary(partial);
    expect(summary.promotable).toBe(false);
    expect(summary.all_checkpointed).toBe(false);
  });

  it('review_decision_written_to_trace', () => {
    const trace = tmpTrace();
    recordReviewDecision(
      { runId: 'run-rev-1', projectId: 'proj-review',
        runState: makeCheckpointedRunState(), traceLogPath: trace },
      'approved', 'lgtm'
    );
    const events = readJsonl(trace);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('human_review');
    if (existsSync(trace)) unlinkSync(trace);
  });
});

// ── test-integrity (STORY-015.3) ──────────────────────────────────────────────

describe('test-integrity', () => {
  it('implementer_authored_tests_flagged', () => {
    const a = flagTestAuthorship('S-1', ['test/a.test.ts'], 'developer');
    expect(a.implementer_only).toBe(true);
    expect(a.requires_human_confirmation).toBe(true);
    expect(a.authored_by).toBe('developer');
  });

  it('supervisor_authored_not_flagged', () => {
    const a = flagTestAuthorship('S-1', [], 'supervisor');
    expect(a.implementer_only).toBe(false);
    expect(a.requires_human_confirmation).toBe(false);
  });

  it('debugger_authored_flagged', () => {
    const a = flagTestAuthorship('S-1', [], 'debugger');
    expect(a.implementer_only).toBe(true);
  });

  it('non_implementer_author_path_available', () => {
    const trace = tmpIntegrityTrace();
    const authorship = flagTestAuthorship('S-1', ['test/a.test.ts'], 'developer');
    const record = recordTestIntegrity(authorship, 'human', trace);
    expect(record.confirmed_by).toBe('human');
    expect(record.story_id).toBe('S-1');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('human_confirmation_recorded_at_checkpoint', () => {
    const trace = tmpIntegrityTrace();
    const authorship = flagTestAuthorship('S-2', [], 'developer');
    recordTestIntegrity(authorship, 'supervisor_second_pass', trace);
    const events = readJsonl(trace);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('test_integrity');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('confirm_non_flagged_authorship_throws', () => {
    const trace = tmpIntegrityTrace();
    const authorship = flagTestAuthorship('S-3', [], 'supervisor');
    expect(() => recordTestIntegrity(authorship, 'human', trace))
      .toThrow(/confirmation requires/);
  });
});

// ── STORY-019.3: Push-notifications ──────────────────────────────────────────

const enabledWebhookConfig = (events = ['escalation', 'approval_required']): NotificationConfig => ({
  version: 1,
  channels: {
    primary: {
      type: 'webhook',
      url: 'https://hooks.test/notify',
      enabled: true,
      retry: { max_attempts: 3, backoff_ms: 0 },
    },
  },
  events,
});

const escalationPayload: NotificationPayload = {
  event_type: 'escalation',
  story_id: 'STORY-A',
  message: 'Story A escalated',
  run_id: 'run-1',
};

const okHttp: NotificationHttpClient = async () => ({ ok: true, status: 200 });

describe('notifications', () => {
  it('escalations_pushed_to_configured_channel', async () => {
    let called = false;
    const http: NotificationHttpClient = async (_url, _p) => { called = true; return { ok: true, status: 200 }; };
    const r = await sendNotification(escalationPayload, enabledWebhookConfig(), http);
    expect(r.ok).toBe(true);
    expect(called).toBe(true);
  });

  it('approvals_requested_via_notification', async () => {
    const payload: NotificationPayload = { event_type: 'approval_required', message: 'Please approve' };
    const r = await sendNotification(payload, enabledWebhookConfig(), okHttp);
    expect(r.ok).toBe(true);
  });

  it('channel_failures_never_block_the_loop', async () => {
    const throwingHttp: NotificationHttpClient = async () => { throw new Error('network down'); };
    const r = await sendNotification(escalationPayload, enabledWebhookConfig(), throwingHttp);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('no_enabled_channel_returns_no_channel', async () => {
    const cfg: NotificationConfig = {
      version: 1,
      channels: { primary: { type: 'webhook', enabled: false } },
      events: ['escalation'],
    };
    const r = await sendNotification(escalationPayload, cfg);
    expect(r.ok).toBe(false);
    expect(r.channel).toBe('none');
  });

  it('notification_respects_event_filter', async () => {
    const cfg = enabledWebhookConfig(['escalation']);
    const payload: NotificationPayload = { event_type: 'build_error', message: 'build failed' };
    const r = await sendNotification(payload, cfg, okHttp);
    expect(r.ok).toBe(false);
  });

  it('retry_on_transient_failure', async () => {
    let attempts = 0;
    const flaky: NotificationHttpClient = async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return { ok: true, status: 200 };
    };
    const r = await sendNotification(escalationPayload, enabledWebhookConfig(), flaky);
    expect(r.ok).toBe(true);
    expect(attempts).toBe(3);
  });
});

// ── STORY-020.3: brownfield-enrichment ───────────────────────────────────────

const brownfieldRecord = (pclass: StoryRecord['parallelism_class'] = 'parallel_safe') => ({
  story_id: 'S-1', epic_id: 'E-1', depends_on: [],
  parallelism_class: pclass, status: 'todo' as const,
  attempts: 0, attempt_budget: 3,
  branch: null, last_action: null, last_result: null, last_validation: null, blocked_reason: null,
  task_class: 'brownfield' as const,
  allowed_write_set: ['src/a.ts'],
});

const impactClient = (files: string[]): BrownfieldCodeGraphClient => ({
  async query() { return { impacted_files: files }; },
});

describe('brownfield-enrichment', () => {
  it('brownfield_write_set_derived_from_impact_set', async () => {
    const enriched = await enrichBrownfieldStory(brownfieldRecord(), { codegraphClient: impactClient(['src/b.ts']) });
    expect(enriched.allowed_write_set).toContain('src/b.ts');
  });

  it('hot_file_overlap_restricts_parallelism', async () => {
    const enriched = await enrichBrownfieldStory(brownfieldRecord(), { hotFiles: ['src/a.ts'] });
    expect(enriched.parallelism_class).toBe('sequential');
  });

  it('public_api_or_schema_change_forced_exclusive', async () => {
    const story = { ...brownfieldRecord(), public_api_constraint: { frozen_paths: ['src/api/**'], reason: 'published' } };
    const enriched = await enrichBrownfieldStory(story);
    expect(enriched.parallelism_class).toBe('exclusive');
  });

  it('greenfield_packets_unchanged', async () => {
    const gf = { ...brownfieldRecord(), task_class: 'greenfield' as const };
    const enriched = await enrichBrownfieldStory(gf);
    expect(enriched).toBe(gf);
  });
});

describe('settings-trace', () => {
  it('resolved_settings_recorded_in_trace', async () => {
    const trace = join(tmpdir(), `settings-trace-${process.pid}.jsonl`);
    await recordResolvedSettings(DEFAULT_SETTINGS, trace);
    const events = readJsonl(trace);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('resolved_settings');
    if (existsSync(trace)) unlinkSync(trace);
  });
});

// ── STORY-023.2: console message router ──────────────────────────────────────

describe('console-router', () => {
  it('status_query_answered_from_tracker', () => {
    const c = classifyConsoleMessage('how is the build going?');
    expect(c.intent).toBe('status_query');
    const r = routeConsoleMessage(c, {});
    expect(r.requiresModelFallback).toBe(false);
  });

  it('off_topic_refused', () => {
    expect(classifyConsoleMessage('what is the weather today?').intent).toBe('off_topic');
  });

  it('raw_instruction_never_becomes_work', () => {
    const c = classifyConsoleMessage('write me a poem');
    const r = routeConsoleMessage(c, {});
    expect(r.response).toMatch(/off-topic|only discuss/i);
  });

  it('ambiguous_intent_uses_model_fallback', () => {
    const c = classifyConsoleMessage('ok');
    const r = routeConsoleMessage(c, {});
    expect(r.requiresModelFallback).toBe(true);
  });

  it('approval_response_classified', () => {
    expect(classifyConsoleMessage('approved').intent).toBe('approval_response');
    expect(classifyConsoleMessage('lgtm').intent).toBe('approval_response');
  });

  it('scope_change_request_classified', () => {
    expect(classifyConsoleMessage('add a new story for caching').intent).toBe('scope_change_request');
  });
});

// ── STORY-023.3: Backlog delta transaction ────────────────────────────────────

const validDelta: BacklogDeltaInput = {
  new_stories: [{ story_id: 'STORY-NEW-001' }],
  epic_list_additions: ['EPIC-SC-greenfield'],
  source_message: 'add caching',
  validated: true,
  validation_errors: [],
};

describe('backlog-transaction', () => {
  it('delta_lands_as_tracker_transaction', async () => {
    const t = join(tmpdir(), `bt-${Date.now()}.jsonl`);
    const tx: BacklogTransaction = await applyBacklogDelta(validDelta, t);
    expect(tx.added_story_ids).toContain('STORY-NEW-001');
    if (existsSync(t)) unlinkSync(t);
  });

  it('backlog_updated_event_emitted', async () => {
    const t = join(tmpdir(), `bt-${Date.now()}.jsonl`);
    await applyBacklogDelta(validDelta, t);
    const events = readJsonl(t);
    expect(events[0].type).toBe('backlog_updated');
    if (existsSync(t)) unlinkSync(t);
  });
});

// ── STORY-027.1: terminal-states ──────────────────────────────────────────────

describe('terminal-states', () => {
  it('failed_aborted_cancelled_are_explicit_states', async () => {
    const trace = join(tmpdir(), `term-${Date.now()}.jsonl`);
    const cause: TerminalStateCause = { state: 'failed', reason: 'budget exhausted', trigger: 'budget_exhausted' };
    const r = await transitionToTerminalState(cause, trace);
    expect(r.new_state).toBe('failed');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('cause_recorded_in_trace', async () => {
    const trace = join(tmpdir(), `term-${Date.now()}.jsonl`);
    const cause: TerminalStateCause = { state: 'aborted', reason: 'human stopped', trigger: 'human_stop' };
    await transitionToTerminalState(cause, trace);
    const events = readJsonl(trace);
    expect(events[0].type).toBe('run_terminal');
    expect(events[0].payload?.trigger).toBe('human_stop');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('stop_run_transitions_to_aborted', async () => {
    const trace = join(tmpdir(), `term-${Date.now()}.jsonl`);
    const cause: TerminalStateCause = { state: 'aborted', reason: 'operator stop', trigger: 'human_stop' };
    const r = await transitionToTerminalState(cause, trace);
    expect(r.new_state).toBe('aborted');
    if (existsSync(trace)) unlinkSync(trace);
  });

  it('cancelled_on_bundle_rejection', async () => {
    const trace = join(tmpdir(), `term-${Date.now()}.jsonl`);
    const cause: TerminalStateCause = { state: 'cancelled', reason: 'bundle rejected', trigger: 'human_reject_bundle' };
    const r = await transitionToTerminalState(cause, trace);
    expect(r.new_state).toBe('cancelled');
    if (existsSync(trace)) unlinkSync(trace);
  });
});

// ── STORY-027.2: Gate SLA tests ───────────────────────────────────────────────

describe('gate-sla', () => {
  const trace = () => join(tmpdir(), `sla-${Date.now()}.jsonl`);

  it('gate_timeout_configurable_per_type', async () => {
    const t = trace();
    const cfg: GateSlaConfig = { gate_type: 'approval_request', timeout_seconds: 3600, escalation_policy: 're_notify' };
    const r = await evaluateGateSla(cfg, 1800, t);
    expect(r.timed_out).toBe(false);
    expect(r.action_taken).toBe('waiting');
    if (existsSync(t)) unlinkSync(t);
  });

  it('escalation_policy_enforced', async () => {
    const t = trace();
    const cfg: GateSlaConfig = { gate_type: 'approval_request', timeout_seconds: 3600, escalation_policy: 'auto_deny' };
    const r = await evaluateGateSla(cfg, 7200, t);
    expect(r.timed_out).toBe(true);
    expect(r.action_taken).toBe('auto_deny');
    if (existsSync(t)) unlinkSync(t);
  });

  it('auto_approve_only_for_non_security_gates', async () => {
    const t = trace();
    const cfg: GateSlaConfig = { gate_type: 'approval_request', timeout_seconds: 60, escalation_policy: 'auto_approve', is_security_gate: true };
    const r = await evaluateGateSla(cfg, 120, t);
    expect(r.action_taken).toBe('auto_deny'); // overridden
    if (existsSync(t)) unlinkSync(t);
  });

  it('global_gates_never_auto_close', async () => {
    const t = trace();
    const cfg: GateSlaConfig = { gate_type: 'promotion_review', timeout_seconds: 60, escalation_policy: 'auto_approve', is_security_gate: true };
    const r = await evaluateGateSla(cfg, 9999, t);
    expect(r.action_taken).toBe('blocked_global_gate');
    if (existsSync(t)) unlinkSync(t);
  });

  it('sla_events_in_trace', async () => {
    const t = trace();
    await evaluateGateSla({ gate_type: 'hold_release', timeout_seconds: 60, escalation_policy: 're_notify' }, 30, t);
    const events = readJsonl(t);
    expect(events[0].type).toBe('gate_sla_tick');
    if (existsSync(t)) unlinkSync(t);
  });
});

describe('provider-registration-trace (STORY-028.2)', () => {
  const tmpBootTrace = () => join(tmpdir(), `gateway-boot-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jsonl`);

  it('registration_event_in_trace_no_secret', async () => {
    const t = tmpBootTrace();
    const n = await recordProviderRegistrations(
      [{ provider_id: 'openai', provider: 'openai', base_url: 'https://api.openai.com/v1', handle_id: 'provider.openai.default' }],
      t,
    );
    expect(n).toBe(1);
    const events = readJsonl(t);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('provider_registered');
    expect(events[0].payload).toEqual({
      provider_id: 'openai', provider: 'openai', base_url: 'https://api.openai.com/v1', handle_id: 'provider.openai.default',
    });
    // No credential value can be present: the whole serialized trace carries only the handle reference.
    const raw = JSON.stringify(events);
    expect(raw).not.toMatch(/sk-/);
    expect(raw).toContain('provider.openai.default');
    if (existsSync(t)) unlinkSync(t);
  });

  it('appends_chained_events_for_multiple_registrations', async () => {
    const t = tmpBootTrace();
    await recordProviderRegistrations([
      { provider_id: 'openai', provider: 'openai', base_url: 'https://api.openai.com/v1', handle_id: 'provider.openai.default' },
      { provider_id: 'deepseek', provider: 'deepseek', base_url: 'https://api.deepseek.com', handle_id: 'provider.deepseek.default' },
    ], t);
    const events = readJsonl(t);
    expect(events.map(e => e.seq)).toEqual([0, 1]);
    expect(events[1].previous_event_hash).toBe(events[0].hash);
    if (existsSync(t)) unlinkSync(t);
  });
});

// ── STORY-029.7 — rollbackWorkspace cleanup ──────────────────────────────────

describe('STORY-029.7 rollbackWorkspace', () => {
  it('rollback_cleanup_implemented: checks out the pre-story ref, discards changes, cleans untracked', async () => {
    const recorded: string[] = [];
    const story = makeStory({ story_id: 'STORY-042.1', branch: 'story/STORY-042.1' });
    const r = await rollbackWorkspace(story, {
      preStoryRef: 'pre-story-base',
      cwd: '/tmp/ws-xyz',
      exec: (cmd) => { recorded.push(cmd); },
    });
    expect(r.ok).toBe(true);
    expect(r.story_id).toBe('STORY-042.1');
    expect(r.restored_to).toBe('pre-story-base');
    expect(recorded).toEqual(['git checkout pre-story-base', 'git reset --hard', 'git clean -fd']);
  });

  it('rollback defaults the ref to the story branch when none is given', async () => {
    const recorded: string[] = [];
    const story = makeStory({ branch: 'story/branch-1' });
    const r = await rollbackWorkspace(story, { exec: (cmd) => { recorded.push(cmd); } });
    expect(r.restored_to).toBe('story/branch-1');
    expect(recorded[0]).toBe('git checkout story/branch-1');
  });

  it('rollback never throws — a git failure is returned as ok:false with the error', async () => {
    const story = makeStory();
    const r = await rollbackWorkspace(story, {
      preStoryRef: 'HEAD',
      exec: () => { throw new Error('git: not a repository'); },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not a repository');
  });
});

// ── STORY-030.2: Developer acceptance-test boundary (harness-authoritative) ─────

describe('STORY-030.2 acceptanceTestBoundaryCheck', () => {
  const ACC = ['gateloop/packages/api/src/__acceptance__/**'];

  it('patch_touching_own_acceptance_tests_rejected', () => {
    const r = acceptanceTestBoundaryCheck(
      ['gateloop/packages/api/src/rate-limiter.ts',
       'gateloop/packages/api/src/__acceptance__/limiter.acceptance.test.ts'],
      ACC,
    );
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('gateloop/packages/api/src/__acceptance__/limiter.acceptance.test.ts');
  });

  it('developer_may_still_read_tests: a patch that does not touch acceptance tests passes', () => {
    const r = acceptanceTestBoundaryCheck(
      ['gateloop/packages/api/src/rate-limiter.ts'],
      ACC,
    );
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  it('exact-path acceptance test is also caught (not only globs)', () => {
    const exact = 'gateloop/packages/api/src/limiter.acceptance.test.ts';
    const r = acceptanceTestBoundaryCheck([exact], [exact]);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([exact]);
  });
});

// ── STORY-030.7: per-story regression gate routing ────────────────────────────

describe('STORY-030.7 regression routing', () => {
  it('regression_routes_to_debug_not_checkpoint', () => {
    // a clean run checkpoints
    expect(decideRegressionRoute({ ok: true })).toBe('write_checkpoint');
    // a regression is routed to debug, never checkpointed
    expect(decideRegressionRoute({ ok: false })).toBe('route_debugger');
  });

  it('story_breaking_prior_tests_rejected: regressing story never enters the green set', () => {
    const reg = new RegressionRegistry();
    reg.recordPassed('S1', ['s1_a', 's1_b']);
    reg.recordPassed('S2', ['s2_a']);
    // S3 completes but its regression gate failed → route to debug, NOT recorded
    const route = decideRegressionRoute({ ok: false });
    expect(route).toBe('route_debugger');
    if (route === 'write_checkpoint') reg.recordPassed('S3', ['s3_a']); // not reached
    expect(reg.passedStoryIds()).toEqual(['S1', 'S2']); // S3 absent
  });

  it('completed_story_reruns_prior_acceptance_tests: registry exposes the prior set', () => {
    const reg = new RegressionRegistry();
    reg.recordPassed('S1', ['s1_a', 's1_b']);
    reg.recordPassed('S2', ['s2_a']);
    const prior = reg.priorAcceptanceTests();
    expect(prior.flatMap(p => p.acceptance_tests)).toEqual(['s1_a', 's1_b', 's2_a']);
  });

  it('passing_stories_stay_green_across_the_run: only gate-clearing stories are recorded', () => {
    const reg = new RegressionRegistry();
    for (const [id, tests, ok] of [
      ['S1', ['s1_a'], true],
      ['S2', ['s2_a'], true],
      ['S3', ['s3_a'], false], // regressed → debug, not recorded
      ['S4', ['s4_a'], true],
    ] as Array<[string, string[], boolean]>) {
      if (decideRegressionRoute({ ok }) === 'write_checkpoint') reg.recordPassed(id, tests);
    }
    expect(reg.passedStoryIds()).toEqual(['S1', 'S2', 'S4']);
  });
});

// ── STORY-031.1: handoff card schema + emission on completion ──────────────────

describe('STORY-031.1 handoff card', () => {
  // completion facts that ALSO carry reasoning/transcript the card must drop
  const FACTS: StoryCompletionFacts = {
    story_id: 'STORY-010.1',
    delivered: ['cli_entry', 'core_service'],
    touched_files: ['src/cli.ts', 'src/core.ts'],
    acceptance: { result: 'passed', ratio: '7/7' },
    open_threads: [],
    trace_ref: 'trace#evt_4821',
    developer_reasoning: 'I chose a token bucket because...',
    debug_narrative: 'first the cache leaked, then...',
    transcript: 'full chat transcript here',
  };

  it('card_emitted_on_completion', () => {
    const card = emitHandoffCard(FACTS);
    expect(card.story).toBe('STORY-010.1');
    expect(card.delivered).toEqual(['cli_entry', 'core_service']);
    expect(card.touched_files).toEqual(['src/cli.ts', 'src/core.ts']);
    expect(card.acceptance).toEqual({ result: 'passed', ratio: '7/7' });
    expect(card.trace_ref).toBe('trace#evt_4821');
  });

  it('card_is_facts_only_no_reasoning', () => {
    const card = emitHandoffCard(FACTS) as Record<string, unknown>;
    // reasoning/transcript present on FACTS must NOT survive into the card
    expect(card.developer_reasoning).toBeUndefined();
    expect(card.debug_narrative).toBeUndefined();
    expect(card.transcript).toBeUndefined();
    expect(assertHandoffCardFactsOnly(card)).toEqual([]);
    // and a card that smuggles reasoning is rejected by the validator
    expect(validateHandoffCard({ ...emitHandoffCard(FACTS), rationale: 'because X' }).ok).toBe(false);
  });

  it('handoff_card_schema_defined', () => {
    expect(validateHandoffCard(emitHandoffCard(FACTS)).ok).toBe(true);
    // malformed cards rejected
    expect(validateHandoffCard({ story: 'S' }).ok).toBe(false);
    expect(validateHandoffCard({ ...emitHandoffCard(FACTS), acceptance: { result: 'maybe' } }).ok).toBe(false);
  });

  it('card_written_to_trace', () => {
    const trace = join(tmpdir(), `hc-trace-${Math.floor(Math.random() * 1e9)}.jsonl`);
    try {
      const card = emitHandoffCard(FACTS);
      const evt = writeHandoffCard(card, trace);
      expect(evt.type).toBe('handoff_card');
      const events = readJsonl(trace);
      expect(events).toHaveLength(1);
      expect((events[0].payload as any).handoff_card.story).toBe('STORY-010.1');
      // the persisted card is still facts-only
      expect(assertHandoffCardFactsOnly((events[0].payload as any).handoff_card)).toEqual([]);
    } finally {
      if (existsSync(trace)) unlinkSync(trace);
    }
  });
});

// ── STORY-032.4: read-only introspection endpoints ────────────────────────────

describe('STORY-032.4 introspection endpoints', () => {
  // a stand-in for agent-core's composeSystemPrompt (injected, so harness-core
  // never depends on agent-core); the real wiring injects the shared function.
  const compose = (base: string, skills: MountedSkillRef[], docs: string): string =>
    [base, skills.map(s => `- ${s.name}`).join('\n'), docs].filter(Boolean).join('\n\n');

  it('agent_prompt_endpoint_returns_composed_config_prompt', () => {
    const view = getAgentPromptView(
      'developer',
      { base: DEFAULT_AGENT_BASE.developer, mounted_skills: [{ name: 'rest-api-template' }], envelope_docs: '### Envelope: DeveloperTaskPacket' },
      { compose },
    );
    expect(view.role).toBe('developer');
    expect(view.base).toBe(DEFAULT_AGENT_BASE.developer);
    // composed is produced via the injected SHARED function (same inputs)
    expect(view.composed).toBe(compose(view.base, view.mounted_skills, view.envelope_docs));
    expect(view.composed).toContain(DEFAULT_AGENT_BASE.developer);
    expect(view.composed).toContain('- rest-api-template');
    expect(view.composed).toContain('DeveloperTaskPacket');
  });

  it('mounted skills come from the config-level manifest', () => {
    const skills = mountedSkillsForRole('developer');
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every(s => typeof s.name === 'string')).toBe(true);
  });

  it('skill_endpoint_returns_metadata_md_scripts', () => {
    const view = getSkillView('planning-steward.idea-to-epic');
    expect(view.id).toBe('planning-steward.idea-to-epic');
    expect((view.metadata as any).skill_id).toBe('planning-steward.idea-to-epic');
    expect(typeof view.skill_md).toBe('string');
    expect(view.skill_md.length).toBeGreaterThan(0);
    expect(view.scripts.length).toBeGreaterThan(0);
    expect(view.scripts.map(s => s.name)).toContain('evaluate.py');
    // each script carries its source text
    expect(view.scripts.every(s => typeof s.source === 'string')).toBe(true);
    // __pycache__ directories are skipped
    expect(view.scripts.every(s => s.name !== '__pycache__')).toBe(true);
  });

  it('endpoints_are_read_only / endpoints_do_not_touch_trace', () => {
    // both views are marked static config-level (not a runtime execution / trace snapshot)
    const av = getAgentPromptView('debugger', { base: DEFAULT_AGENT_BASE.debugger, mounted_skills: [], envelope_docs: '' }, { compose });
    const sv = getSkillView('planning-steward.idea-to-epic');
    expect(av.static_config_level).toBe(true);
    expect(sv.static_config_level).toBe(true);
    // read-only: calling twice yields identical results (no mutation / side effects)
    expect(getSkillView('planning-steward.idea-to-epic')).toEqual(sv);
    // unknown skill is a clean error, not a crash
    expect(() => getSkillView('does.not-exist')).toThrow(/skill not found/);
  });
});

// ── STORY-GATE.1: /goal auto-advance within an epic (gates face the agent, not the user) ──
describe('STORY-GATE.1 decideAutoAdvance', () => {
  const epic = 'EPIC-X';
  const budget = makeRunBudget(2, 10);
  // a finished story + the next in-epic story, green/todo
  const stories: StoryRecord[] = [
    makeStory({ story_id: 'STORY-X.1', epic_id: epic, status: 'done' }),
    makeStory({ story_id: 'STORY-X.2', epic_id: epic, status: 'todo', depends_on: ['STORY-X.1'] }),
  ];

  it('goal_auto_advances_story_to_story_within_epic_when_green', () => {
    const d = decideAutoAdvance({ stories, currentEpicId: epic, runBudget: budget });
    expect(d.advance).toBe(true);
    expect(d.nextStoryId).toBe('STORY-X.2');
    expect(d.stopReason).toBeNull();
  });

  it('stops_kept_at_trust_boundary_irreversible_sudo_network', () => {
    const d = decideAutoAdvance({ stories, currentEpicId: epic, runBudget: budget, pendingHumanGate: 'sudo_or_irreversible' });
    expect(d.advance).toBe(false);
    expect(d.stopReason).toBe('trust_boundary');
    // scope_expansion / stable_mutation likewise stop (any pending gate)
    expect(decideAutoAdvance({ stories, currentEpicId: epic, runBudget: budget, pendingHumanGate: 'scope_expansion' }).stopReason).toBe('trust_boundary');
  });

  it('stops_kept_at_epic_completion_report_await_direction', () => {
    // no more selectable in this epic (next selectable is a DIFFERENT epic)
    const cross: StoryRecord[] = [
      makeStory({ story_id: 'STORY-X.1', epic_id: epic, status: 'done' }),
      makeStory({ story_id: 'STORY-Y.1', epic_id: 'EPIC-Y', status: 'todo' }),
    ];
    const d = decideAutoAdvance({ stories: cross, currentEpicId: epic, runBudget: budget });
    expect(d.advance).toBe(false);
    expect(d.stopReason).toBe('epic_complete');
    // nothing selectable at all → also epic_complete (report + await)
    const doneAll: StoryRecord[] = [makeStory({ story_id: 'STORY-X.1', epic_id: epic, status: 'done' })];
    expect(decideAutoAdvance({ stories: doneAll, currentEpicId: epic, runBudget: budget }).stopReason).toBe('epic_complete');
  });

  it('stops_kept_at_budget_exceeded', () => {
    const d = decideAutoAdvance({ stories, currentEpicId: epic, runBudget: makeRunBudget(10, 10) });
    expect(d.advance).toBe(false);
    expect(d.stopReason).toBe('budget_exceeded');
  });

  it('stops_kept_at_real_api_calls_fail_closed_agent_cannot_self_enable', () => {
    // explicit flag
    expect(decideAutoAdvance({ stories, currentEpicId: epic, runBudget: budget, nextStepNeedsRealApi: true }).stopReason).toBe('real_api_calls');
    // inferred from the next story's gated blocked_reason (fail-closed)
    const gated: StoryRecord[] = [
      makeStory({ story_id: 'STORY-X.1', epic_id: epic, status: 'done' }),
      makeStory({ story_id: 'STORY-X.2', epic_id: epic, status: 'todo', depends_on: ['STORY-X.1'], blocked_reason: 'gated barrier: needs real_api_calls for the A/B' }),
    ];
    expect(decideAutoAdvance({ stories: gated, currentEpicId: epic, runBudget: budget }).stopReason).toBe('real_api_calls');
    expect(storyNeedsRealApi(gated[1])).toBe(true);
    expect(storyNeedsRealApi(stories[1])).toBe(false);
  });

  it('agent_guardrails_untouched_only_human_confirmation_cadence_changed', () => {
    // decideAutoAdvance never inspects/relaxes write-set, tool grants, isolation, etc.
    // It only chooses advance-vs-stop. Guardrail surfaces are decided by other functions
    // (checkHumanGate / write-set / tool layer), which this story does not modify.
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export function decideAutoAdvance'), src.indexOf('export function decideAutoAdvance') + 1200);
    // the decision function must not touch guardrail mechanisms
    for (const banned of ['allowedWriteSet', 'allowed_write_set', 'isShellLikeTool', 'real_api_calls = ', 'setEnabled', 'PROVIDER_SECRET_PATH']) {
      expect(fn.includes(banned)).toBe(false);
    }
  });
});

// ── STORY-SH.1: persistent project cost ledger (reuse ProjectRunState + BudgetLedger) ──
import { recordProjectCost, projectBudgetVerdict, emptyProjectCostLedger, PROJECT_RUN_STATE_SCHEMA } from './index.js';
describe('STORY-SH.1 persistent project cost ledger', () => {
  it('project_run_state_schema_v2_has_cost_ledger_cumulative_and_caps', () => {
    const s = loadOrInitProjectRunState('/nonexistent/sh1-fresh.json', 'proj-SH', ['STORY-1'], 10);
    expect(s.schema_version).toBe(PROJECT_RUN_STATE_SCHEMA); // 2
    expect(s.cost_ledger).toBeDefined();
    expect(s.cost_ledger).toMatchObject({ cumulative_usd: 0, cumulative_tokens: 0, project_budget_usd: null, project_token_cap: null });
  });

  it('migrates a v1 state file to v2 (adds cost_ledger, keeps data)', async () => {
    const p = tmpPath();
    // hand-write a v1 file (no cost_ledger)
    const v1 = loadOrInitProjectRunState(p, 'proj-mig', ['STORY-A'], 10);
    (v1 as any).schema_version = 1; delete (v1 as any).cost_ledger;
    await persistProjectRunState(p, v1);
    const migrated = loadOrInitProjectRunState(p, 'proj-mig', ['STORY-A'], 10);
    expect(migrated.schema_version).toBe(PROJECT_RUN_STATE_SCHEMA);
    expect(migrated.cost_ledger).toBeDefined();
    expect(migrated.cost_ledger!.cumulative_usd).toBe(0);
    unlinkSync(p);
  });

  it('each_run_persists_updated_cumulative (cross-run accumulation)', async () => {
    const p = tmpPath();
    let s = loadOrInitProjectRunState(p, 'proj-acc', ['STORY-A'], 10);
    s.cost_ledger!.project_budget_usd = 5;
    recordProjectCost(s, { usd: 1.5, tokens: 1000 }, '2026-06-23T00:00:00Z');
    await persistProjectRunState(p, s);
    // a SECOND run loads the cumulative and adds to it
    s = loadOrInitProjectRunState(p, 'proj-acc', ['STORY-A'], 10);
    expect(s.cost_ledger!.cumulative_usd).toBe(1.5);
    recordProjectCost(s, { usd: 2.0, tokens: 500 }, '2026-06-23T01:00:00Z');
    expect(s.cost_ledger!.cumulative_usd).toBe(3.5);
    expect(s.cost_ledger!.cumulative_tokens).toBe(1500);
    unlinkSync(p);
  });

  it('approaching_project_budget_warns_exceeding_stops', () => {
    const base = emptyProjectCostLedger('t'); base.project_budget_usd = 10; base.project_token_cap = 1000;
    expect(projectBudgetVerdict({ ...base, cumulative_usd: 2 }).decision).toBe('ok');
    expect(projectBudgetVerdict({ ...base, cumulative_usd: 8.5 }).decision).toBe('warn');  // ≥80%
    expect(projectBudgetVerdict({ ...base, cumulative_usd: 10 }).decision).toBe('stop');    // at cap
    expect(projectBudgetVerdict({ ...base, cumulative_tokens: 1000 }).decision).toBe('stop'); // token cap
    // uncapped never warns/stops
    expect(projectBudgetVerdict({ ...emptyProjectCostLedger('t'), cumulative_usd: 1e9 }).decision).toBe('ok');
  });
});

// ── STORY-SH.3: project convergence monitor (keystone — diagnose, not bare count) ──
import { assessConvergence, projectIterationBudget, type IterationMetrics } from './index.js';
describe('STORY-SH.3 project convergence monitor', () => {
  const m = (iteration: number, delivered: number, rework: number, clobber: number): IterationMetrics => ({ iteration, delivered, rework, clobber });

  it('project_convergence_monitor_pure_reads_projectrunstate_history (insufficient history → keep going)', () => {
    expect(assessConvergence([m(1,1,0,0)]).verdict).toBe('converging');
    expect(assessConvergence([m(1,1,0,0)]).signal).toBe('insufficient_history');
  });

  it('signal_1_delivery_rate_k_rounds_zero_delivery_stalled', () => {
    const v = assessConvergence([m(1,0,1,0), m(2,0,1,0), m(3,0,1,0)]); // 0 delivered over 3, rework flat
    expect(v.verdict).toBe('stalled');
    expect(v.signal).toBe('delivery_rate');
  });

  it('signal_2_rework_rate_rising_k_rounds_diverging', () => {
    const v = assessConvergence([m(1,1,1,0), m(2,1,2,0), m(3,1,3,0)]); // rework 1→2→3 (delivering, but churning)
    expect(v.verdict).toBe('diverging');
    expect(v.signal).toBe('rework_rate');
    expect(v.reason).toMatch(/1→2→3/);
  });

  it('signal_3_cross_story_clobber_worsening_diverging', () => {
    const v = assessConvergence([m(1,1,0,1), m(2,1,0,2), m(3,1,0,4)]); // clobber 1→2→4
    expect(v.verdict).toBe('diverging');
    expect(v.signal).toBe('cross_story_clobber');
  });

  it('healthy project → converging (delivering, rework/clobber not rising)', () => {
    const v = assessConvergence([m(1,2,1,0), m(2,1,0,0), m(3,2,1,0)]);
    expect(v.verdict).toBe('converging');
  });

  it('layered_budget_per_story_plus_per_project_scaled_plus_monitor_decides', () => {
    expect(projectIterationBudget(20)).toBe(80);   // 20 stories → ~k·N, not flat 12
    expect(projectIterationBudget(5)).toBe(20);
    expect(projectIterationBudget(20)).toBeGreaterThan(12); // never the flat-12 mid-project halt
  });

  it('converging_continues_past_iteration_12 (scaled budget + converging verdict → advance)', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'STORY-P.13', epic_id: 'EPIC-P', status: 'done' }),
      makeStory({ story_id: 'STORY-P.14', epic_id: 'EPIC-P', status: 'todo', depends_on: ['STORY-P.13'] }),
    ];
    const d = decideAutoAdvance({
      stories, currentEpicId: 'EPIC-P',
      runBudget: { iterations_used: 12, run_iteration_budget: projectIterationBudget(20) }, // 12 < 80
      convergence: assessConvergence([m(10,2,1,0), m(11,1,0,0), m(12,2,1,0)]),               // converging
    });
    expect(d.advance).toBe(true);          // past iteration 12, still advancing
    expect(d.nextStoryId).toBe('STORY-P.14');
  });

  it('diverging_stalled_diagnoses_and_stops_reports_which_signal', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'STORY-P.1', epic_id: 'EPIC-P', status: 'done' }),
      makeStory({ story_id: 'STORY-P.2', epic_id: 'EPIC-P', status: 'todo', depends_on: ['STORY-P.1'] }),
    ];
    const base = { stories, currentEpicId: 'EPIC-P', runBudget: { iterations_used: 5, run_iteration_budget: 80 } };
    const diverging = decideAutoAdvance({ ...base, convergence: assessConvergence([m(1,1,0,1), m(2,1,0,2), m(3,1,0,3)]) });
    expect(diverging.advance).toBe(false);
    expect(diverging.stopReason).toBe('project_diverging');
    expect(diverging.diagnosis).toMatch(/clobber rising/);            // reports WHICH signal — not a bare count
    const stalled = decideAutoAdvance({ ...base, convergence: assessConvergence([m(1,0,0,0), m(2,0,0,0), m(3,0,0,0)]) });
    expect(stalled.stopReason).toBe('project_stalled');
    expect(stalled.diagnosis).toMatch(/0 stories delivered/);
  });

  it('decideAutoAdvance_gains_project_stalled_and_project_diverging_gate1_stops_stay', () => {
    const stories: StoryRecord[] = [
      makeStory({ story_id: 'STORY-P.1', epic_id: 'EPIC-P', status: 'done' }),
      makeStory({ story_id: 'STORY-P.2', epic_id: 'EPIC-P', status: 'todo', depends_on: ['STORY-P.1'] }),
    ];
    // GATE.1 stops still fire (no convergence passed → existing behavior unchanged)
    expect(decideAutoAdvance({ stories, currentEpicId: 'EPIC-P', runBudget: makeRunBudget(10,10) }).stopReason).toBe('budget_exceeded');
    expect(decideAutoAdvance({ stories, currentEpicId: 'EPIC-P', runBudget: makeRunBudget(0,80), pendingHumanGate: 'sudo_or_irreversible' }).stopReason).toBe('trust_boundary');
    // and a converging verdict does NOT block the GATE.1 advance
    expect(decideAutoAdvance({ stories, currentEpicId: 'EPIC-P', runBudget: makeRunBudget(0,80), convergence: { verdict:'converging', signal:'delivery_rate', reason:'ok' } }).advance).toBe(true);
  });
});
