// Orchestrator — GateLoop inner-loop state machine engine.
//
// Responsibilities:
//   1. Drive story state transitions (tick)
//   2. Select the next story respecting the dependency DAG (selectNextStory)
//   3. Enforce attempt and run budgets (enforceAttemptBudget, enforceRunBudget)
//   4. Detect human gate triggers deterministically (checkHumanGate)
//   5. Record checkpoints and rollback (checkpoint, rollback)
//
// Nothing here is an LLM. Every decision is deterministic and auditable.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Types ────────────────────────────────────────────────────────────────────

/** UI-facing trace event type for the TraceViewer component. */
export interface TraceEvent {
  event_id: string;
  type: string;
  story_id?: string;
  payload: Record<string, unknown>;
  recorded_at: string;
  seq?: number;
  event_type?: string;
  agent_role?: string;
  summary?: string;
}

export type StoryStatus =
  | 'todo' | 'in_progress' | 'validating' | 'debugging'
  | 'passed' | 'checkpointed' | 'blocked' | 'escalated' | 'done';

export type HarnessState =
  | 'IDEA_INBOX' | 'PLANNING_BUNDLE' | 'SUPERVISOR_CONTRACT'
  | 'DEVELOPER_PATCH_PROPOSAL' | 'DEVELOPER_PREFLIGHT' | 'SPEC_CONFORMANCE_REVIEW'
  | 'WORKSPACE_APPLY' | 'VALIDATION'
  | 'DEBUG_LOOP' | 'CHECKPOINT' | 'HUMAN_GATE' | 'PROMOTION_REVIEW' | 'DONE';

export type OrchestratorAction =
  | 'run_bootstrap'          // Step 0: capture env snapshot
  | 'select_story'           // pick next story from DAG
  | 'issue_contract'         // Supervisor issues StoryContract
  | 'request_patch'          // Developer turn
  | 'apply_patch'            // Tool Executor applies the proposal to the workspace branch
  | 'run_validation'         // Validator runs validation_commands
  | 'route_debugger'         // hand to Debugger on failure
  | 'retry_develop'          // back to Developer after a repair
  | 'write_checkpoint'       // save state; mark story checkpointed
  | 'escalate_human'         // stop + ask; never continue until human responds
  | 'rollback_workspace'     // revert the workspace branch to the pre-story snapshot
  | 'mark_story_done'        // story is done; update tracker
  | 'stop_run';              // run budget exhausted or stop condition fired

export type HumanGateReason =
  | 'scope_expansion'        // repair requires writing outside allowed_write_set
  | 'attempt_budget_exceeded'// max develop<->debug cycles exhausted
  | 'run_budget_exceeded'    // max stories for this /goal run exhausted
  | 'systemic_failure'       // failure gene consolidated_count >= threshold
  | 'stable_mutation'        // writing to protected/production path
  | 'promotion'              // promoting from workspace to main
  | 'first_enable_provider'  // first use of a new model provider
  | 'policy_change'          // any change to policy.yaml or decision_matrix
  | 'sudo_or_irreversible';  // any sudo / rm -rf / destructive command

// ── Legal transitions ─────────────────────────────────────────────────────────

const TRANSITIONS: Record<HarnessState, HarnessState[]> = {
  IDEA_INBOX:              ['PLANNING_BUNDLE'],
  PLANNING_BUNDLE:         ['SUPERVISOR_CONTRACT'],
  SUPERVISOR_CONTRACT:     ['DEVELOPER_PATCH_PROPOSAL'],
  DEVELOPER_PATCH_PROPOSAL:['DEVELOPER_PREFLIGHT', 'HUMAN_GATE'],          // preflight next, or escalate instead of guessing
  DEVELOPER_PREFLIGHT:     ['SPEC_CONFORMANCE_REVIEW', 'DEVELOPER_PATCH_PROPOSAL', 'HUMAN_GATE'], // advisory: pass→conformance, self-correct (bounded), or escalate
  SPEC_CONFORMANCE_REVIEW: ['WORKSPACE_APPLY', 'DEVELOPER_PATCH_PROPOSAL', 'HUMAN_GATE'],          // HARD gate: pass→apply, fix proposal, or escalate
  WORKSPACE_APPLY:         ['VALIDATION'],
  VALIDATION:              ['DEBUG_LOOP', 'CHECKPOINT', 'HUMAN_GATE'],
  DEBUG_LOOP:              ['DEVELOPER_PATCH_PROPOSAL', 'SUPERVISOR_CONTRACT', 'HUMAN_GATE'],
  CHECKPOINT:              ['PROMOTION_REVIEW', 'SUPERVISOR_CONTRACT'],  // next story or promote
  HUMAN_GATE:              ['SUPERVISOR_CONTRACT', 'CHECKPOINT', 'DONE'],
  PROMOTION_REVIEW:        ['DONE', 'HUMAN_GATE'],
  DONE:                    [],
};

export function canTransition(from: HarnessState, to: HarnessState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Story record (mirrors tracker_state.json.stories[n]) ─────────────────────

export interface StoryRecord {
  story_id: string;
  epic_id: string;
  depends_on: string[];
  parallelism_class: 'parallel_safe' | 'parallel_with_barrier' | 'sequential' | 'exclusive';
  status: StoryStatus;
  attempts: number;
  attempt_budget: number;
  branch: string | null;
  last_action: string | null;
  last_result: string | null;
  last_validation: string | null;
  blocked_reason: string | null;
}

export interface RunBudget {
  run_iteration_budget: number;
  iterations_used: number;
}

// ── Story selection (DAG-aware) ───────────────────────────────────────────────

/**
 * Return the story_id that should run next, or null if nothing is runnable.
 * Rules:
 *  1. All depends_on stories must be 'done'.
 *  2. Status must be 'todo' (or 'blocked' being retried after a human clears it).
 *  3. Among candidates, prefer lower epic_id then lower story_id (stable ordering).
 *  4. 'exclusive' stories block all parallel work; wait until they are done.
 */
export function selectNextStory(stories: StoryRecord[]): string | null {
  const done = new Set(stories.filter(s => s.status === 'done').map(s => s.story_id));
  const hasExclusiveRunning = stories.some(
    s => s.parallelism_class === 'exclusive' && s.status === 'in_progress'
  );
  if (hasExclusiveRunning) return null;

  const candidates = stories.filter(s =>
    (s.status === 'todo') &&
    s.depends_on.every(dep => done.has(dep))
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.epic_id.localeCompare(b.epic_id) || a.story_id.localeCompare(b.story_id));
  return candidates[0].story_id;
}

// ── Budget enforcement ────────────────────────────────────────────────────────

export function enforceAttemptBudget(
  story: StoryRecord
): 'ok' | 'escalate' {
  return story.attempts < story.attempt_budget ? 'ok' : 'escalate';
}

export function enforceRunBudget(budget: RunBudget): 'ok' | 'stop' {
  return budget.iterations_used < budget.run_iteration_budget ? 'ok' : 'stop';
}

// ── Human gate detection (deterministic — never trusts agent self-report) ─────

/** Returns the gate reason if the proposed action requires human approval, or null. */
export function checkHumanGate(
  action: OrchestratorAction,
  story: StoryRecord,
  context: { changedFiles?: string[]; allowedWriteSet?: string[]; isPromotion?: boolean }
): HumanGateReason | null {
  if (action === 'escalate_human') return 'attempt_budget_exceeded'; // already decided upstream
  if (context.isPromotion) return 'promotion';
  if (action === 'apply_patch' && context.changedFiles && context.allowedWriteSet) {
    const outside = context.changedFiles.filter(f =>
      !context.allowedWriteSet!.some(pattern => matchesGlob(f, pattern))
    );
    if (outside.length > 0) return 'scope_expansion';
  }
  if (story.blocked_reason?.startsWith('systemic_failure')) return 'systemic_failure';
  return null;
}

// ── Core tick ────────────────────────────────────────────────────────────────

export interface TickInput {
  state: HarnessState;
  story: StoryRecord;
  runBudget: RunBudget;
  lastValidationPassed: boolean | null;
  humanGateCleared: boolean;
}

/**
 * Single-step the orchestrator: given the current state and story, return
 * the next action. Pure function — no side effects.
 */
export function tick(input: TickInput): OrchestratorAction {
  const { state, story, runBudget, lastValidationPassed, humanGateCleared } = input;

  if (enforceRunBudget(runBudget) === 'stop') return 'stop_run';

  switch (state) {
    case 'SUPERVISOR_CONTRACT':    return 'issue_contract';
    case 'DEVELOPER_PATCH_PROPOSAL': return 'request_patch';
    case 'WORKSPACE_APPLY':        return 'apply_patch';

    case 'VALIDATION':
      if (lastValidationPassed === true)  return 'write_checkpoint';
      if (lastValidationPassed === false) {
        return enforceAttemptBudget(story) === 'ok' ? 'route_debugger' : 'escalate_human';
      }
      return 'run_validation';

    case 'DEBUG_LOOP':
      return enforceAttemptBudget(story) === 'ok' ? 'retry_develop' : 'escalate_human';

    case 'CHECKPOINT':
      return 'mark_story_done';

    case 'HUMAN_GATE':
      return humanGateCleared ? 'select_story' : 'stop_run';

    case 'PROMOTION_REVIEW':
      return 'escalate_human';   // promotion always requires human approval

    default:
      return 'stop_run';
  }
}

// ── Checkpoint + rollback primitives (stubs) ──────────────────────────────────

// ── Test authorship / integrity (STORY-015.3) ─────────────────────────────────

export type TestAuthorRole = 'developer' | 'debugger' | 'supervisor' | 'human' | 'unknown';

export interface TestAuthorshipRecord {
  story_id: string;
  test_files: string[];
  authored_by: TestAuthorRole;
  /** True when the implementer (developer/debugger) is the sole test author. */
  implementer_only: boolean;
  /** If implementer_only, a human or supervisor must confirm before CHECKPOINT. */
  requires_human_confirmation: boolean;
  recorded_at: string;
}

export interface TestIntegrityRecord {
  story_id: string;
  authorship: TestAuthorshipRecord;
  confirmed_by: 'human' | 'supervisor_second_pass';
  confirmed_at: string;
  trace_event_id: string;
}

export function flagTestAuthorship(
  storyId: string,
  testFiles: string[],
  implementerRole: TestAuthorRole
): TestAuthorshipRecord {
  const implementer_only = implementerRole === 'developer' || implementerRole === 'debugger';
  return {
    story_id: storyId,
    test_files: testFiles,
    authored_by: implementerRole,
    implementer_only,
    requires_human_confirmation: implementer_only,
    recorded_at: new Date().toISOString(),
  };
}

export function recordTestIntegrity(
  authorship: TestAuthorshipRecord,
  confirmedBy: 'human' | 'supervisor_second_pass',
  traceLogPath: string
): TestIntegrityRecord {
  if (!authorship.requires_human_confirmation) {
    throw new Error('test integrity confirmation requires human or supervisor_second_pass');
  }
  const existing = readJsonl(traceLogPath);
  const last = existing[existing.length - 1];
  const traceEvent = createTraceEvent({
    run_id: authorship.story_id,
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'test_integrity',
    payload: { story_id: authorship.story_id, confirmed_by: confirmedBy, authored_by: authorship.authored_by },
  });
  appendJsonl(traceLogPath, traceEvent);
  return {
    story_id: authorship.story_id,
    authorship,
    confirmed_by: confirmedBy,
    confirmed_at: new Date().toISOString(),
    trace_event_id: traceEvent.event_id,
  };
}

// ── Developer acceptance-test boundary (STORY-030.2, harness-authoritative) ────

export interface AcceptanceTestBoundaryResult {
  ok: boolean;
  /** changed files that illegally touch the story's own acceptance tests. */
  violations: string[];
}

/**
 * STORY-030.2: hard boundary — a Developer patch must never author or modify the
 * story's own acceptance-test files. The Developer writes implementation; the bar
 * it is judged against is authored by the Assessor / Planning (separation of
 * generation from assessment). This is the harness-authoritative mirror of
 * developer-runtime's pre-emit gate: even if the agent gate were bypassed, the
 * harness rejects the patch here. Glob semantics: ** = any, * = non-slash.
 */
export function acceptanceTestBoundaryCheck(
  changedFiles: string[],
  acceptanceTestPaths: string[],
): AcceptanceTestBoundaryResult {
  const matches = (p: string, glob: string): boolean =>
    p === glob || new RegExp('^' +
      glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$'
    ).test(p);
  const violations = changedFiles.filter(f => acceptanceTestPaths.some(g => matches(f, g)));
  return { ok: violations.length === 0, violations };
}

// ── Per-story regression gate routing (STORY-030.7) ───────────────────────────

export interface StoryAcceptanceTests {
  story_id: string;
  acceptance_tests: string[];
}

export type RegressionRoute = 'write_checkpoint' | 'route_debugger';

/**
 * STORY-030.7: a completed story may only checkpoint if it did not break any
 * previously-passed story's acceptance tests. If the regression gate failed
 * (a prior test now fails), the story is routed to the Debugger — never
 * checkpointed. This is the post-validation decision that sits between
 * VALIDATION-passed and CHECKPOINT for the multi-story run.
 */
export function decideRegressionRoute(regression: { ok: boolean }): RegressionRoute {
  return regression.ok ? 'write_checkpoint' : 'route_debugger';
}

/**
 * STORY-030.7: accumulates the acceptance tests of every previously-passed story
 * so a later story's completion can re-run them. A story is recorded as passed
 * (its tests joining the green set) ONLY after it both validates and clears the
 * regression gate — so a regressing story never enters the green set.
 */
export class RegressionRegistry {
  private readonly passed: StoryAcceptanceTests[] = [];

  /** Acceptance tests of all previously-passed stories, to be re-run on completion. */
  priorAcceptanceTests(): StoryAcceptanceTests[] {
    return this.passed.map(p => ({ story_id: p.story_id, acceptance_tests: [...p.acceptance_tests] }));
  }

  /** Story ids currently in the green (passed + non-regressing) set. */
  passedStoryIds(): string[] {
    return this.passed.map(p => p.story_id);
  }

  /** Record a story as passed — only call after it cleared the regression gate. */
  recordPassed(story_id: string, acceptance_tests: string[]): void {
    this.passed.push({ story_id, acceptance_tests: [...acceptance_tests] });
  }
}

// ── Handoff card: facts-only cross-story inheritance (STORY-031.1) ────────────
//
// When a story completes it emits a HANDOFF CARD: a tiny, structured, facts-only
// record (delivered capabilities, touched files, acceptance result, open threads,
// and a trace_ref pointer). The next story inherits the card — NOT the previous
// story's context. The card deliberately omits reasoning, the debug narrative,
// and any "how we got there": carrying those across stories would anchor the next
// story to the previous one's framing (the contamination EPIC-030 removed within a
// story, now prevented between stories). The full process stays in the trace,
// reachable via trace_ref. Design: docs/architecture/15_CONTEXT_INHERITANCE_AND_COMPACTION.md.

export type AcceptanceResult = 'passed' | 'failed' | 'partial';

export interface HandoffCardAcceptance {
  result: AcceptanceResult;
  ratio?: string;
}

export interface HandoffCard {
  story: string;
  delivered: string[];
  touched_files: string[];
  acceptance: HandoffCardAcceptance;
  open_threads: string[];
  /** Pointer back to the full process in the trace (e.g. trace#evt_4821). */
  trace_ref: string;
}

/**
 * Story-completion facts the card is built from. Any extra keys (reasoning,
 * transcript, debug narrative) are IGNORED — never copied into the card.
 */
export interface StoryCompletionFacts {
  story_id: string;
  delivered: string[];
  touched_files: string[];
  acceptance: HandoffCardAcceptance;
  open_threads?: string[];
  trace_ref: string;
  [k: string]: unknown;
}

/** Reasoning/process keys a facts-only card must never carry. */
export const HANDOFF_CARD_FORBIDDEN_KEYS = [
  'reasoning', 'developer_reasoning', 'debugger_reasoning', 'agent_reasoning',
  'debug_narrative', 'transcript', 'rationale', 'rationale_summary',
  'thought', 'thoughts', 'chain_of_thought', 'how', 'process', 'approach',
] as const;

const HANDOFF_CARD_KEYS = ['story', 'delivered', 'touched_files', 'acceptance', 'open_threads', 'trace_ref'];

/**
 * STORY-031.1: build a facts-only handoff card on story completion. Only the fact
 * fields are copied — any reasoning/transcript present on `facts` is dropped by
 * construction, so the card is facts-only regardless of what the caller passes.
 */
export function emitHandoffCard(facts: StoryCompletionFacts): HandoffCard {
  return {
    story: facts.story_id,
    delivered: [...facts.delivered],
    touched_files: [...facts.touched_files],
    acceptance: {
      result: facts.acceptance.result,
      ...(facts.acceptance.ratio !== undefined ? { ratio: facts.acceptance.ratio } : {}),
    },
    open_threads: [...(facts.open_threads ?? [])],
    trace_ref: facts.trace_ref,
  };
}

/**
 * STORY-031.1 invariant: a card carries facts only. Returns any reasoning/process
 * keys present (empty = facts-only). Used as a tested guard, not a comment.
 */
export function assertHandoffCardFactsOnly(obj: Record<string, unknown>): string[] {
  return HANDOFF_CARD_FORBIDDEN_KEYS.filter(k => obj[k] !== undefined && obj[k] !== null);
}

/** STORY-031.1: validate a handoff card against handoff_card.schema.json (facts-only). */
export function validateHandoffCard(card: unknown): { ok: boolean; errors: string[] } {
  if (typeof card !== 'object' || card === null) {
    return { ok: false, errors: ['handoff card must be a non-null object'] };
  }
  const c = card as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof c.story !== 'string' || !c.story.trim()) errors.push('missing: story');
  for (const arr of ['delivered', 'touched_files', 'open_threads'] as const) {
    if (!Array.isArray(c[arr])) errors.push(`${arr} must be an array`);
  }
  const acc = c.acceptance as Record<string, unknown> | undefined;
  if (typeof acc !== 'object' || acc === null || !['passed', 'failed', 'partial'].includes(acc.result as string)) {
    errors.push('acceptance.result must be passed|failed|partial');
  }
  if (typeof c.trace_ref !== 'string' || !c.trace_ref.trim()) errors.push('missing: trace_ref');
  // facts-only: no reasoning keys, no keys beyond the card shape
  const leaked = assertHandoffCardFactsOnly(c);
  if (leaked.length > 0) errors.push(`card carries reasoning/process keys (facts-only violated): ${leaked.join(', ')}`);
  const extra = Object.keys(c).filter(k => !HANDOFF_CARD_KEYS.includes(k));
  if (extra.length > 0) errors.push(`card has non-fact keys: ${extra.join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/**
 * STORY-031.1: write the handoff card to the trace as a `handoff_card` event.
 * The trace is the single full record; the card is its facts-only index entry.
 */
export function writeHandoffCard(card: HandoffCard, traceLogPath: string): ReturnType<typeof appendNextEvent> {
  return appendNextEvent(traceLogPath, {
    run_id: card.story,
    type: 'handoff_card',
    agent_role: 'supervisor',
    payload: { handoff_card: card },
  });
}

// ── Static asset introspection endpoints (STORY-032.4) ────────────────────────
//
// Two READ-ONLY views. Neither touches the trace; neither is an execution snapshot.
// They show the assets AS CONFIGURED, so an operator can judge whether a bad output
// is prompt/skill authoring vs model capability.
//
//   GET /agents/{role}/prompt → config-level composed prompt (via the SHARED
//     composeSystemPrompt, 032.3, with config-representative inputs — injected so
//     harness-core stays dependency-light and the composition logic is never duplicated).
//   GET /skills/{id} → metadata + SKILL.md + scripts source (read from the skill dir).
// Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md.

const HARNESS_REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // gateloop/

export interface MountedSkillRef {
  name: string;
  summary?: string;
}

/** Config-representative base templates per role (config-level, not an execution instance). */
export const DEFAULT_AGENT_BASE: Record<string, string> = {
  planning_steward: 'You are the Planning Steward. Turn human intent into a testable spec; never touch code or agents.',
  supervisor: 'You are the Supervisor. Decide the next state and compose task packets; you are the brain, not the hands.',
  developer: 'You are the Developer. Produce a minimal, additive, reversible patch within the write-set; you do not author your own acceptance tests.',
  debugger: 'You are the Debugger. Diagnose from the broken result, acceptance, and diff; you never see the Developer\'s reasoning.',
  reviewer: 'You are the Reviewer. Read-only advisory; emit a ranked diagnosis and audit whether the acceptance tests are meaningful.',
  assessor: 'You are the Assessor. Author concrete acceptance tests from the intent, run them, and judge satisfaction; you write no product code.',
};

/** Read the registered skills a role mounts, from the skill manifest (config-level). */
export function mountedSkillsForRole(role: string, repoRoot: string = HARNESS_REPO_ROOT): MountedSkillRef[] {
  const manifestPath = nodePath.join(repoRoot, 'skills', 'skill_manifest.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills?: any[] };
  return (manifest.skills ?? [])
    .filter(s => s.agent_role === role && s.status === 'registered')
    .map(s => ({ name: s.skill_id as string }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface AgentPromptInput {
  base: string;
  mounted_skills: MountedSkillRef[];
  /** The envelope-format docs section (generated from schema, 032.2) — injected. */
  envelope_docs: string;
}

export interface AgentPromptComposeDeps {
  /** The SHARED composeSystemPrompt (032.3), injected so harness-core need not
   *  depend on agent-core and the composition logic is never duplicated. */
  compose: (base: string, mountedSkills: MountedSkillRef[], envelopeDocs: string) => string;
}

export interface AgentPromptView {
  role: string;
  base: string;
  mounted_skills: MountedSkillRef[];
  envelope_docs: string;
  composed: string;
  /** Always true — this is the configured composition, NOT a runtime execution. */
  static_config_level: true;
}

/**
 * STORY-032.4: GET /agents/{role}/prompt — the config-level composed prompt. Uses
 * the injected SHARED composeSystemPrompt with config-representative inputs, so the
 * view is composed identically to what the executor sends. Read-only; touches no trace.
 */
export function getAgentPromptView(role: string, input: AgentPromptInput, deps: AgentPromptComposeDeps): AgentPromptView {
  return {
    role,
    base: input.base,
    mounted_skills: input.mounted_skills,
    envelope_docs: input.envelope_docs,
    composed: deps.compose(input.base, input.mounted_skills, input.envelope_docs),
    static_config_level: true,
  };
}

export interface SkillScriptSource {
  name: string;
  source: string;
}

export interface SkillView {
  id: string;
  metadata: Record<string, unknown>;
  skill_md: string;
  scripts: SkillScriptSource[];
  /** Always true — static asset, not a runtime execution. */
  static_config_level: true;
}

/**
 * STORY-032.4: GET /skills/{id} — the skill's full contents: metadata (skill.json),
 * SKILL.md markdown, and every script's source. Reads the skill directory directly;
 * touches no trace, runs nothing. Read-only.
 */
export function getSkillView(skillId: string, repoRoot: string = HARNESS_REPO_ROOT): SkillView {
  const manifestPath = nodePath.join(repoRoot, 'skills', 'skill_manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills?: any[] };
  const entry = (manifest.skills ?? []).find(s => s.skill_id === skillId);
  if (!entry) throw new Error(`skill not found: ${skillId}`);

  const dir = nodePath.join(repoRoot, entry.path as string);
  const metadata = JSON.parse(readFileSync(nodePath.join(dir, 'skill.json'), 'utf8')) as Record<string, unknown>;
  const mdPath = nodePath.join(dir, 'SKILL.md');
  const skill_md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';

  const scripts: SkillScriptSource[] = [];
  const scriptsDir = nodePath.join(dir, 'scripts');
  if (existsSync(scriptsDir)) {
    for (const name of readdirSync(scriptsDir).sort()) {
      const full = nodePath.join(scriptsDir, name);
      if (statSync(full).isDirectory()) continue; // skip __pycache__ and the like
      scripts.push({ name, source: readFileSync(full, 'utf8') });
    }
  }
  return { id: skillId, metadata, skill_md, scripts, static_config_level: true };
}

export interface CheckpointRecord {
  story_id: string;
  branch: string;
  commit_sha: string;
  checkpointed_at: string;
  test_integrity?: TestIntegrityRecord;   // present when tests required confirmation
}

export async function writeCheckpoint(story: StoryRecord): Promise<CheckpointRecord> {
  const { execSync } = await import('child_process');
  const branch = `checkpoint/${story.story_id}`;
  try {
    execSync(`git add -A && git commit -m "checkpoint: ${story.story_id}" --allow-empty`, { stdio: 'pipe' });
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    return { story_id: story.story_id, branch, commit_sha: sha, checkpointed_at: new Date().toISOString() };
  } catch {
    return { story_id: story.story_id, branch, commit_sha: 'stub-no-git', checkpointed_at: new Date().toISOString() };
  }
}

/** Options for rollbackWorkspace. Everything is injectable so the cleanup is
 *  CI-safe and testable without ever touching the real repository. */
export interface RollbackOptions {
  /** The ref to restore to (the pre-story branch/commit). Defaults to the story
   *  branch, else 'HEAD'. */
  preStoryRef?: string;
  /** Working directory of the disposable workspace. Defaults to process.cwd(). */
  cwd?: string;
  /** Injected command runner — tests pass a recorder; production uses execSync. */
  exec?: (cmd: string, cwd: string) => void;
}

export interface RollbackResult {
  ok: boolean;
  story_id: string;
  restored_to: string;
  commands: string[];
  error?: string;
}

/**
 * Roll back a disposable workspace after a failed/aborted story: check out the
 * pre-story ref, discard tracked changes, and remove untracked files. Operates
 * on the given workspace `cwd` and never throws — a failure is returned as
 * `{ ok: false, error }` so the loop can escalate instead of crashing.
 */
export async function rollbackWorkspace(story: StoryRecord, options: RollbackOptions = {}): Promise<RollbackResult> {
  const cwd = options.cwd ?? process.cwd();
  const preStoryRef = options.preStoryRef ?? story.branch ?? 'HEAD';
  const commands = [
    `git checkout ${preStoryRef}`,
    'git reset --hard',
    'git clean -fd',
  ];
  try {
    if (options.exec) {
      for (const c of commands) options.exec(c, cwd);
    } else {
      const { execSync } = await import('child_process');
      for (const c of commands) execSync(c, { cwd, stdio: 'pipe' });
    }
    return { ok: true, story_id: story.story_id, restored_to: preStoryRef, commands };
  } catch (err) {
    return { ok: false, story_id: story.story_id, restored_to: preStoryRef, commands, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Project-level run state (per-target-project resume) ──────────────────────

export interface ProjectStoryEntry {
  story_id: string;
  status: StoryStatus;
  attempts: number;
  attempt_budget: number;
  checkpoint_sha: string | null;
  last_action: string | null;
  last_result: string | null;
  blocked_reason: string | null;
}

export interface ProjectRunState {
  schema_version: number;
  project_id: string;
  run_id: string;
  created_at: string;
  updated_at: string;
  current_story: string | null;
  last_decision: string | null;
  iterations_used: number;
  run_iteration_budget: number;
  stories: ProjectStoryEntry[];
}

export function loadOrInitProjectRunState(
  filePath: string,
  projectId: string,
  storyIds: string[],
  runIterationBudget: number
): ProjectRunState {
  if (existsSync(filePath)) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ProjectRunState;
    if (parsed.schema_version !== 1) {
      throw new Error(`ProjectRunState schema_version must be 1, got ${parsed.schema_version}`);
    }
    return parsed;
  }
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    project_id: projectId,
    run_id: now,
    created_at: now,
    updated_at: now,
    current_story: null,
    last_decision: null,
    iterations_used: 0,
    run_iteration_budget: runIterationBudget,
    stories: storyIds.map(id => ({
      story_id: id,
      status: 'todo',
      attempts: 0,
      attempt_budget: 3,
      checkpoint_sha: null,
      last_action: null,
      last_result: null,
      blocked_reason: null,
    })),
  };
}

export async function persistProjectRunState(
  filePath: string,
  state: ProjectRunState
): Promise<void> {
  const { writeFileSync, renameSync } = await import('fs');
  state.updated_at = new Date().toISOString();
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, filePath);
}

// ── Human review domain (STORY-012.2) ────────────────────────────────────────

import crypto from 'node:crypto';
import { createTraceEvent, appendJsonl, readJsonl, appendNextEvent } from '@gateloop/event-log';

export type ReviewOutcome = 'approved' | 'denied';

export interface ReviewDecision {
  decision_id: string;
  run_id: string;
  project_id: string;
  outcome: ReviewOutcome;
  reason: string;
  decided_at: string;
  validation_evidence: { story_id: string; checkpoint_sha: string }[];
  trace_event_id: string;
}

export interface ReviewContext {
  runId: string;
  projectId: string;
  runState: ProjectRunState;
  traceLogPath: string;
}

export interface ReviewSummary {
  project_id: string;
  run_id: string;
  total_stories: number;
  done_count: number;
  all_checkpointed: boolean;
  validation_evidence: { story_id: string; checkpoint_sha: string | null }[];
  promotable: boolean;
}

export function buildReviewSummary(runState: ProjectRunState): ReviewSummary {
  const stories = runState.stories;
  const done_count = stories.filter(s => s.status === 'done').length;
  const all_checkpointed = stories.every(s => s.checkpoint_sha !== null);
  return {
    project_id: runState.project_id,
    run_id: runState.run_id,
    total_stories: stories.length,
    done_count,
    all_checkpointed,
    validation_evidence: stories.map(s => ({ story_id: s.story_id, checkpoint_sha: s.checkpoint_sha })),
    promotable: done_count === stories.length && all_checkpointed,
  };
}

export function recordReviewDecision(
  ctx: ReviewContext,
  outcome: ReviewOutcome,
  reason: string
): ReviewDecision {
  if (outcome === 'denied' && !reason) {
    throw new Error('deny requires a reason');
  }
  const resolvedReason = reason || 'operator approved';
  const existing = readJsonl(ctx.traceLogPath);
  const last = existing[existing.length - 1];
  const traceEvent = createTraceEvent({
    run_id: ctx.runId,
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'human_review',
    payload: { outcome, reason: resolvedReason, run_id: ctx.runId, project_id: ctx.projectId },
  });
  appendJsonl(ctx.traceLogPath, traceEvent);
  const validation_evidence = ctx.runState.stories
    .filter(s => s.checkpoint_sha !== null)
    .map(s => ({ story_id: s.story_id, checkpoint_sha: s.checkpoint_sha as string }));
  return {
    decision_id: crypto.randomUUID(),
    run_id: ctx.runId,
    project_id: ctx.projectId,
    outcome,
    reason: resolvedReason,
    decided_at: new Date().toISOString(),
    validation_evidence,
    trace_event_id: traceEvent.event_id,
  };
}

// ── STORY-020.3: Brownfield-aware task-packet composition ─────────────────────

/** Minimal codegraph client interface (structural — compatible with @gateloop/codegraph-adapter). */
export interface BrownfieldCodeGraphClient {
  query(q: { operation: string; target: string; readScope?: string[] }): Promise<{
    impacted_files?: string[];
  }>;
}

export interface StoryEnrichmentOptions {
  codegraphClient?: BrownfieldCodeGraphClient;
  hotFiles?: string[];
}

type BrownfieldStoryInput = StoryRecord & {
  task_class?: string;
  public_api_constraint?: { frozen_paths: string[]; reason: string };
  allowed_write_set?: string[];
};

export async function enrichBrownfieldStory(
  story: BrownfieldStoryInput,
  opts: StoryEnrichmentOptions = {}
): Promise<BrownfieldStoryInput> {
  if (story.task_class !== 'brownfield') return story;

  const enriched: BrownfieldStoryInput = { ...story };

  if (story.public_api_constraint) {
    enriched.parallelism_class = 'exclusive';
  }

  if (opts.codegraphClient) {
    const files = story.allowed_write_set ?? [];
    const raw = await opts.codegraphClient.query({ operation: 'impact', target: files.join(',') });
    enriched.allowed_write_set = raw.impacted_files ?? files;
  }

  if (opts.hotFiles && opts.hotFiles.length > 0) {
    const writeSet = enriched.allowed_write_set ?? [];
    const hasOverlap = writeSet.some(f => opts.hotFiles!.includes(f));
    if (hasOverlap && enriched.parallelism_class !== 'exclusive') {
      enriched.parallelism_class = 'sequential';
    }
  }

  return enriched;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** Minimal glob matcher (supports ** and * wildcards). */
function matchesGlob(path: string, pattern: string): boolean {
  const re = new RegExp('^' + pattern.replace(/\*\*/g,'___DSTAR___').replace(/\*/g,'[^/]*').replace(/___DSTAR___/g,'.*') + '$');
  return re.test(path);
}

// ── Orchestrator v0 public API (STORY-001) ────────────────────────────────────
// Re-exported so consumers can import from @gateloop/harness-core without
// reaching into internal source paths.

export {
  selectNextRuntimeStory,
  hasBlockedOrEscalatedDependency,
  decideNextAction,
  advanceTrackerState,
  buildResumeSummary,
} from './orchestrator-v0.ts';

export type {
  TrackerState,
  RuntimeStory,
  RuntimeDecision,
  ActionResult,
  OrchestratorV0State,
  OrchestratorV0Action,
  RuntimeStoryStatus,
} from './orchestrator-v0.ts';

// ── STORY-019.3: Push-notifications for escalations and approvals ─────────────

export interface NotificationChannel {
  type: 'webhook' | 'email';
  url?: string;
  address?: string;
  enabled: boolean;
  retry?: { max_attempts: number; backoff_ms: number };
}

export interface NotificationConfig {
  version: number;
  channels: { primary: NotificationChannel; email?: NotificationChannel };
  events: string[];
}

export interface NotificationPayload {
  event_type: string;
  story_id?: string;
  run_id?: string;
  message: string;
  trace_event_id?: string;
}

export type NotificationHttpClient = (
  url: string,
  payload: NotificationPayload
) => Promise<{ ok: boolean; status: number }>;

export interface NotificationResult {
  ok: boolean;
  channel: string;
  error?: string;
}

const defaultHttpClient: NotificationHttpClient = async (url, payload) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
};

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── STORY-021.2: Resolved settings trace recording ───────────────────────────

export async function recordResolvedSettings(
  settings: import('@gateloop/settings').HarnessSettings,
  traceLogPath: string
): Promise<void> {
  const existing = readJsonl(traceLogPath);
  const last = existing[existing.length - 1];
  const event = createTraceEvent({
    run_id: 'settings-boot',
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'resolved_settings',
    payload: settings as Record<string, unknown>,
  });
  appendJsonl(traceLogPath, event);
}

// ── STORY-028.2: Live provider bootstrap — registration trace recording ──────
// Appends a non-secret `provider_registered` event per live adapter built at
// boot. The input carries handle references only; combined with createTraceEvent's
// redaction, no secret value can reach the append-only trace. Structurally typed
// so the gateway's BootstrapResult.registered can be passed directly without a
// package dependency on the gateway.

export interface ProviderRegistrationRecord {
  provider_id: string;
  provider: string;
  base_url: string;
  handle_id: string;
}

export async function recordProviderRegistrations(
  registrations: ProviderRegistrationRecord[],
  traceLogPath: string
): Promise<number> {
  const existing = readJsonl(traceLogPath);
  for (const r of registrations) {
    const last = existing[existing.length - 1];
    const event = createTraceEvent({
      run_id: 'gateway-boot',
      seq: last ? last.seq + 1 : 0,
      previous_event_hash: last ? (last.hash ?? null) : null,
      type: 'provider_registered',
      payload: {
        provider_id: r.provider_id,
        provider: r.provider,
        base_url: r.base_url,
        handle_id: r.handle_id,
      },
    });
    appendJsonl(traceLogPath, event);
    existing.push(event);
  }
  return registrations.length;
}

export async function sendNotification(
  payload: NotificationPayload,
  config: NotificationConfig,
  httpClient?: NotificationHttpClient
): Promise<NotificationResult> {
  if (!config.events.includes(payload.event_type)) {
    return { ok: false, channel: 'none', error: 'event type not in configured events' };
  }

  const primary = config.channels.primary;

  if (!primary.enabled) {
    return { ok: false, channel: 'none', error: 'no enabled channel' };
  }

  if (primary.type === 'email') {
    return { ok: false, channel: 'email', error: 'email not implemented' };
  }

  if (primary.type === 'webhook') {
    if (!primary.url) {
      return { ok: false, channel: 'webhook', error: 'webhook url not configured' };
    }
    const http = httpClient ?? defaultHttpClient;
    const maxAttempts = primary.retry?.max_attempts ?? 1;
    const backoffMs = primary.retry?.backoff_ms ?? 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await http(primary.url, payload);
        if (result.ok) return { ok: true, channel: 'webhook' };
        if (attempt < maxAttempts) await sleep(backoffMs);
      } catch (e: unknown) {
        if (attempt < maxAttempts) {
          await sleep(backoffMs);
          continue;
        }
        return { ok: false, channel: 'webhook', error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { ok: false, channel: 'webhook', error: 'all retry attempts failed' };
  }

  return { ok: false, channel: 'none', error: 'unknown channel type' };
}

// ── STORY-023.3: Backlog delta transaction ────────────────────────────────────

/** Structural subset of BacklogDelta — avoids a harness-core→planning-steward reference. */
export interface BacklogDeltaInput {
  new_stories: Array<{ story_id: string }>;
  epic_list_additions: string[];
  source_message: string;
  validated: boolean;
  validation_errors: string[];
}

export interface BacklogTransaction {
  added_story_ids: string[];
  epic_list_additions: string[];
  transaction_at: string;
}

export async function applyBacklogDelta(
  delta: BacklogDeltaInput,
  traceLogPath: string,
): Promise<BacklogTransaction> {
  if (!delta.validated) {
    throw new Error('backlog_delta_rejected: validation failed');
  }

  const added_story_ids = delta.new_stories.map(s => s.story_id);
  const epic_list_additions = delta.epic_list_additions;
  const transaction_at = new Date().toISOString();

  const existing = readJsonl(traceLogPath);
  const last = existing[existing.length - 1];
  const event = createTraceEvent({
    run_id: 'backlog-update',
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'backlog_updated',
    payload: { added_story_ids, epic_list_additions },
  });
  appendJsonl(traceLogPath, event);

  return { added_story_ids, epic_list_additions, transaction_at };
}

// ── STORY-027.1: Terminal run states ─────────────────────────────────────────

export type TerminalRunState = 'failed' | 'aborted' | 'cancelled';

export interface TerminalStateCause {
  state: TerminalRunState;
  reason: string;
  trigger: 'budget_exhausted' | 'repo_invalid' | 'attempt_budget_consumed'
         | 'human_stop' | 'human_reject_bundle' | 'run_dropped';
  story_id?: string;
}

export type RunTerminationResult = {
  previous_state: string;
  new_state: TerminalRunState;
  cause: TerminalStateCause;
  trace_event_id: string;
};

export async function transitionToTerminalState(
  cause: TerminalStateCause,
  traceLogPath: string
): Promise<RunTerminationResult> {
  const existing = readJsonl(traceLogPath);
  const last = existing[existing.length - 1];
  const event = createTraceEvent({
    run_id: cause.story_id ?? 'run',
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'run_terminal',
    payload: cause as unknown as Record<string, unknown>,
  });
  appendJsonl(traceLogPath, event);
  return {
    previous_state: 'running',
    new_state: cause.state,
    cause,
    trace_event_id: event.event_id,
  };
}

// ── STORY-027.2: Human gate SLA — timeout, escalation, global gate protection ─

export type GateType = 'promotion_review' | 'approval_request' | 'hold_release';
export type EscalationPolicy = 're_notify' | 'auto_deny' | 'auto_approve';

export const GLOBAL_GATES_NO_AUTO_CLOSE = [
  'real_api_calls', 'sudo_broker_runtime', 'bypass_workspace_runtime', 'stable_promotion',
] as const;

export interface GateSlaConfig {
  gate_type: GateType;
  timeout_seconds: number;
  escalation_policy: EscalationPolicy;
  is_security_gate?: boolean;
}

export interface GateSlaResult {
  gate_type: GateType;
  elapsed_seconds: number;
  timed_out: boolean;
  action_taken: EscalationPolicy | 'waiting' | 'blocked_global_gate';
  trace_event_id: string;
}

export async function evaluateGateSla(
  config: GateSlaConfig,
  elapsedSeconds: number,
  traceLogPath: string
): Promise<GateSlaResult> {
  const timed_out = elapsedSeconds >= config.timeout_seconds;

  let action_taken: GateSlaResult['action_taken'];

  if (config.gate_type === 'promotion_review') {
    // promotion_review is always a global gate — never auto-close
    action_taken = 'blocked_global_gate';
  } else if (!timed_out) {
    action_taken = 'waiting';
  } else if (config.escalation_policy === 'auto_approve' && config.is_security_gate) {
    // safety override: security gates can never auto_approve
    action_taken = 'auto_deny';
  } else {
    action_taken = config.escalation_policy;
  }

  const existing = readJsonl(traceLogPath);
  const last = existing[existing.length - 1];
  const event = createTraceEvent({
    run_id: 'gate-sla',
    seq: last ? last.seq + 1 : 0,
    previous_event_hash: last ? (last.hash ?? null) : null,
    type: 'gate_sla_tick',
    payload: {
      gate_type: config.gate_type,
      elapsed_seconds: elapsedSeconds,
      timeout_seconds: config.timeout_seconds,
      timed_out,
      action_taken,
      is_security_gate: config.is_security_gate ?? false,
    },
  });
  appendJsonl(traceLogPath, event);

  return {
    gate_type: config.gate_type,
    elapsed_seconds: elapsedSeconds,
    timed_out,
    action_taken,
    trace_event_id: event.event_id,
  };
}

// ── STORY-023.2: Console message router ──────────────────────────────────────

export type MessageIntent =
  | 'status_query' | 'off_topic' | 'approval_response'
  | 'scope_change_request' | 'ambiguous';

export interface ClassifiedMessage {
  message_id: string;
  text: string;
  intent: MessageIntent;
  classified_at: string;
  classification_method: 'keyword' | 'grammar' | 'model_fallback' | null;
}

export interface ConsoleRouterConfig {
  pendingGateStoryId?: string;
}

export interface RouterResult {
  intent: MessageIntent;
  response: string;
  requiresModelFallback: boolean;
}

const _APPROVAL_POSITIVE = /^(approved?|lgtm|yes[!.]*)$/;
const _APPROVAL_NEGATIVE = /^(den(?:y|ied)|reject(?:ed)?|no[!.]*)$/;
const _STATUS_KEYWORDS = /\b(status|what['’]?s\s+happening|how\s+is|progress|current)\b/;
const _SCOPE_CHANGE_KEYWORDS = /(add\s+stor|new\s+stor|change\s+scope|add\s+feature|add\s+requirement)/;
const _HARNESS_GOAL_STATUS = /^\/(goal|status)\b/;
const _HARNESS_APPROVE = /^\/approve\b/;
const _PROJECT_NOUNS = /\b(stor(?:y|ies)|build|deploy(?:ment)?|cod(?:e|ing)|task(?:s)?|test(?:ing|s)?|harness|epic|ticket|patch|debug(?:ging)?|validat(?:e|ion|ing)|commit|branch|feature|run|progress|approv(?:e|al)|review|checkpoint|plan|trace|developer|supervisor|iteration|pipeline|sprint|backlog|defect|bug|fix)\b/;
const _QUESTION_STARTERS = /^(what|who|where|when|why|how)\b/;
const _IMPERATIVE_KEYWORDS = /^(write(?:\s+me)?|tell\s+me|explain|describe|help\s+me|give\s+me|generate|create\s+a|make\s+(?:me\s+)?a|draw|show\s+me)\b/;

export function classifyConsoleMessage(
  text: string,
  messageId?: string,
): ClassifiedMessage {
  const id = messageId ?? crypto.randomUUID();
  const classified_at = new Date().toISOString();
  const normalized = text.trim().toLowerCase();

  function result(intent: MessageIntent, classification_method: ClassifiedMessage['classification_method']): ClassifiedMessage {
    return { message_id: id, text, intent, classified_at, classification_method };
  }

  // Rule 1: approval positive
  if (_APPROVAL_POSITIVE.test(normalized)) return result('approval_response', 'keyword');

  // Rule 2: approval negative
  if (_APPROVAL_NEGATIVE.test(normalized)) return result('approval_response', 'keyword');

  // Rule 3: status query
  if (_STATUS_KEYWORDS.test(normalized)) return result('status_query', 'keyword');

  // Rule 4: scope change
  if (_SCOPE_CHANGE_KEYWORDS.test(normalized)) return result('scope_change_request', 'keyword');

  // Rule 5: harness commands
  if (_HARNESS_GOAL_STATUS.test(normalized)) return result('status_query', 'keyword');
  if (_HARNESS_APPROVE.test(normalized)) return result('approval_response', 'keyword');

  // Rule 6: off-topic heuristic (grammar)
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  const hasProjectNoun = _PROJECT_NOUNS.test(normalized);
  if (!hasProjectNoun && wordCount > 2 &&
      (_QUESTION_STARTERS.test(normalized) || _IMPERATIVE_KEYWORDS.test(normalized))) {
    return result('off_topic', 'grammar');
  }

  // Rule 7: ambiguous
  return result('ambiguous', null);
}

export function routeConsoleMessage(
  classified: ClassifiedMessage,
  cfg: ConsoleRouterConfig,
): RouterResult {
  switch (classified.intent) {
    case 'status_query':
      return { intent: 'status_query', response: 'narrating from tracker — no model call needed', requiresModelFallback: false };
    case 'approval_response':
      return cfg.pendingGateStoryId
        ? { intent: 'approval_response', response: `approval recorded for STORY-${cfg.pendingGateStoryId}`, requiresModelFallback: false }
        : { intent: 'approval_response', response: 'no pending gate for this approval', requiresModelFallback: false };
    case 'off_topic':
      return { intent: 'off_topic', response: 'off-topic: I only discuss the current project run', requiresModelFallback: false };
    case 'scope_change_request':
      return { intent: 'scope_change_request', response: 'scope change: routing to Planning Steward', requiresModelFallback: false };
    case 'ambiguous':
      return { intent: 'ambiguous', response: 'intent unclear — using model fallback', requiresModelFallback: true };
  }
}

// ── STORY-033.6: external-agent delegation exit-gate outcome → runtime decision ──
// Ties the (driver-agnostic) exit gate verdict (@gateloop/agent-delegate) into the
// orchestrator. Structural input keeps harness-core decoupled from agent-delegate.
// The verdict ALWAYS derives from the diff (write-set/spec/validator/regression/
// Assessor); the agent's self-report never reaches here.

export interface DelegationExitVerdictLike {
  accepted: boolean;
  /** A change fell outside the write-set ⇒ the whole proposal was rejected. */
  rejected_whole: boolean;
  out_of_write_set: string[];
}

export interface DelegationOutcomeDecision {
  action: OrchestratorAction;
  human_gate_reason?: HumanGateReason;
  reason: string;
}

/**
 * Map a delegation exit-gate verdict onto the next runtime action:
 *  - accepted ⇒ write_checkpoint (the diff passed every gate within the write-set),
 *  - out-of-write-set rejection ⇒ escalate_human (scope_expansion — never auto-widened),
 *  - other gate failure within the write-set ⇒ route_debugger.
 * Deterministic; no LLM.
 */
export function decideDelegationOutcome(v: DelegationExitVerdictLike): DelegationOutcomeDecision {
  if (v.accepted) {
    return { action: 'write_checkpoint', reason: 'delegation exit gate accepted: diff within write-set, all gates passed' };
  }
  if (v.rejected_whole && v.out_of_write_set.length > 0) {
    return {
      action: 'escalate_human',
      human_gate_reason: 'scope_expansion',
      reason: `delegation changed out-of-write-set files (whole proposal rejected): ${v.out_of_write_set.join(', ')}`,
    };
  }
  return { action: 'route_debugger', reason: 'delegation exit gate rejected (gate failure within write-set); route to debugger' };
}
