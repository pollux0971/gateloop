/**
 * @gateloop/supervisor-runtime
 *
 * Deterministic helpers for the Supervisor (brain, not hands). The ROUTING is
 * deterministic (the v0 decision table); an LLM is used only to compose packet prose
 * and judgement, never to decide routing or to execute anything.
 * Spec: gateloop/docs/agents/02_SUPERVISOR_AGENT.md
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export type SupervisorAction =
  | 'replan' | 'call_developer' | 'validate' | 'call_debugger' | 'checkpoint'
  | 'abort_attempt' | 'ask_human' | 'rollback' | 'wait';

export interface SupervisorState {
  storyReady: boolean;
  developerResult?: { patchProposal: boolean } | null;
  validationReport?: { status: 'passed' | 'failed'; failureType?: string } | null;
  permissionDenied?: { needsScopeExpansion?: boolean } | null;
  debuggerResult?: { withinScope: boolean; needsScopeExpansion?: boolean } | null;
  humanIssue?: { severity: 'low'|'medium'|'high'|'critical'; klass?: string } | null;
  sameSignatureCount: number;
  attempts: { developer: number; debugger: number };
  budget: { developer: number; debugger: number; sameSignature: number };
}
export interface SupervisorDecision { type: SupervisorAction; reason: string }

/** The v0 decision table (corrected). Ordered; first match wins. Pure function. */
export function decideNextAction(s: SupervisorState): SupervisorDecision {
  if (!s.storyReady) return { type: 'replan', reason: 'story not development-ready' };
  if (s.humanIssue) {
    if (s.humanIssue.severity === 'critical' || s.humanIssue.klass === 'security')
      return { type: 'ask_human', reason: 'security/critical human issue: freeze + gate' };
    return { type: 'call_debugger', reason: 'human issue: investigation only (not yet a bug)' };
  }
  if (s.permissionDenied)
    return s.permissionDenied.needsScopeExpansion
      ? { type: 'ask_human', reason: 'pre-apply denial needs scope expansion' }
      : { type: 'abort_attempt', reason: 'permission denied before apply; discard workspace changes' };
  if (s.validationReport?.status === 'passed') return { type: 'checkpoint', reason: 'validation passed' };
  if (s.validationReport?.status === 'failed') {
    if (s.sameSignatureCount >= s.budget.sameSignature) return { type: 'ask_human', reason: 'repeated failure signature' };
    if (s.attempts.debugger >= s.budget.debugger || s.attempts.developer >= s.budget.developer)
      return { type: 'ask_human', reason: 'attempt budget exhausted' };
    return { type: 'call_debugger', reason: 'validation failed: route to debugger' };
  }
  if (s.debuggerResult) {
    if (s.debuggerResult.needsScopeExpansion) return { type: 'ask_human', reason: 'repair scope exceeds story' };
    if (s.debuggerResult.withinScope) return { type: 'validate', reason: 'validate repair' };
  }
  if (s.developerResult?.patchProposal && !s.validationReport) return { type: 'validate', reason: 'developer result: validate it' };
  if (s.storyReady && !s.developerResult) return { type: 'call_developer', reason: 'story ready: dispatch developer' };
  return { type: 'wait', reason: 'awaiting next artifact' };
}

export interface StoryContractView { objective?: string; allowed_write_set?: string[];
  acceptance_criteria?: string[]; validation_commands?: string[]; rollback_notes?: string; }
/** Returns the missing required fields ([] = ready). Mirrors validator-suite. */
export function validateStoryReady(c: StoryContractView): string[] {
  return ['objective','allowed_write_set','acceptance_criteria','validation_commands','rollback_notes']
    .filter(k => { const v = (c as Record<string, unknown>)[k]; return v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === ''; });
}

// ── Developer Task Packet composition (STORY-029.2) ──────────────────────────
// The Supervisor is brain, not hands: it deterministically renders the story
// contract into a dispatchable Developer Task Packet conforming to
// specs/task_packet.schema.json. Relevant context section refs (via 008.2) and
// matching failure-bank AVOID warnings (via 008.3) are dependency-injected by the
// caller, so this stays a pure, deterministic function decoupled from those
// packages. Given the same contract + context + warnings, it yields the same packet.

/** The slice of a StoryContract this composer reads. Superset of StoryContractView. */
export interface StoryContractForPacket {
  story_id?: string;
  story_contract_ref?: string;
  contract_version?: number;
  objective?: string;
  task_title?: string;
  background?: string;
  expected_behavior?: string[];
  non_goals?: string[];
  allowed_write_set?: string[];
  forbidden_actions?: string[];
  acceptance_criteria?: string[];
  validation_commands?: string[];
  required_files?: { create?: string[]; update?: string[]; do_not_touch?: string[] };
  rollback_notes?: string;
  /** WORK 3a: deterministic complexity tier (a router signal). */
  estimated_complexity?: 'trivial' | 'small' | 'medium' | 'large' | 'xlarge';
}

// ── WORK B: deterministic task signals (domain + context need) for the router ──
// Inferred from the contract (write-set + complexity) with pure rules — NOT an LLM —
// so the Supervisor stays 0 askModel and the signals are reproducible. The router
// (WORK C) matches these against each model's capabilities/context_window.

/** Task domains a story touches, inferred from its write-set paths. */
export function inferTaskDomains(writeSet: string[] = []): string[] {
  const isFrontend = (p: string) => /\.(tsx|jsx|css|scss|html)$/.test(p) || /(^|\/)apps\/web\//.test(p) || /(^|\/)(components|ui|pages)\//i.test(p);
  const isBackend = (p: string) => /\.(ts|mjs|cjs|js|py|go|rs)$/.test(p) && !/\.(tsx|jsx)$/.test(p)
    || /(^|\/)(packages|apps\/api|server|src\/api|services)\//.test(p);
  const domains = new Set<string>();
  for (const p of writeSet) {
    if (isFrontend(p)) domains.add('frontend');
    if (isBackend(p)) domains.add('backend');
  }
  // Default to backend when nothing matched (most product code is backend logic).
  if (domains.size === 0) domains.add('backend');
  return [...domains].sort();
}

/**
 * Whether a task needs a large context scan (cross-file refactor / whole-codebase
 * analysis). Deterministic: a wide write-set OR a large/xlarge complexity tier.
 */
export function inferNeedsLongContext(input: { writeSet?: string[]; estimated_complexity?: string }): boolean {
  const files = input.writeSet?.length ?? 0;
  const big = input.estimated_complexity === 'large' || input.estimated_complexity === 'xlarge';
  return files >= 4 || big;
}

export interface TaskSignals { domains: string[]; needs_long_context: boolean }

/** The full deterministic task-signal bundle the router consumes. */
export function inferTaskSignals(c: { allowed_write_set?: string[]; estimated_complexity?: string }): TaskSignals {
  return {
    domains: inferTaskDomains(c.allowed_write_set),
    needs_long_context: inferNeedsLongContext({ writeSet: c.allowed_write_set, estimated_complexity: c.estimated_complexity }),
  };
}

/** Minimal shape of a matching failure-bank warning. Structurally compatible with
 *  FailureGene from @gateloop/failure-bank (008.3) — only the injected essentials
 *  are needed here, keeping supervisor-runtime decoupled. The `avoid` field is operative. */
export interface FailureBankWarning {
  matching_signal: string;
  avoid: string;
  consolidated_count?: number;
}

export interface DeveloperPacketInput {
  contract: StoryContractForPacket;
  /** Relevant context section refs resolved via 008.2 (context-manager). */
  contextRefs?: string[];
  /** Exclusion patterns (secrets, unrelated logs) for the context packet. */
  excludePatterns?: string[];
  /** Matching failure-bank warnings resolved via 008.3 (failure-bank.injectRelevant). */
  failureWarnings?: FailureBankWarning[];
  /** Deterministic packet id; defaults from the story id. */
  packetId?: string;
  /** Structured outputs the developer must return. */
  outputRequired?: string[];
}

export interface DeveloperTaskPacket {
  packet_id: string;
  story_id: string;
  story_contract_ref: string;
  contract_version?: number;
  target_agent: 'developer';
  task_title: string;
  task_goal: string;
  task_details: { background: string; expected_behavior: string[]; non_goals: string[] };
  allowed_write_set: string[];
  forbidden_actions: string[];
  required_files: { create: string[]; update: string[]; do_not_touch: string[] };
  validation_commands: string[];
  acceptance_criteria: string[];
  rollback_requirement: { required: boolean; expected_content: string[] };
  context_packet: { include_refs: string[]; exclude_patterns: string[] };
  output_required: string[];
  /** §1a: explicit preserve-existing-behavior directive. Always present (it must NOT
   *  collapse into acceptance_criteria), so the Developer is always told to keep prior
   *  behavior intact when modifying shared files. */
  behavior_preservation: string[];
  /** WORK B: deterministic task signals (domain + context need) the router consumes. */
  task_signals: TaskSignals;
  /** WORK 3a: complexity tier carried on the packet so the router can read it. */
  estimated_complexity?: 'trivial' | 'small' | 'medium' | 'large' | 'xlarge';
}

/** §1a: the always-present preserve-existing-behavior directive carried in every
 *  Developer Task Packet (independent of whether the contract enumerated behaviors). */
export const BEHAVIOR_PRESERVATION_DIRECTIVE: string[] = [
  'Preserve ALL existing behavior in files you modify — be additive at the LINE level.',
  'Do not remove, replace, or weaken existing exported functions or behavior unless THIS story explicitly requires it.',
  'A `modify` that drops existing lines/behavior is a violation, not just a `delete` — the harness rejects it.',
];

/** A packet is never delivered with raw secrets, unrelated full logs, or whole-repo dumps. */
export const DEFAULT_PACKET_EXCLUDE_PATTERNS: string[] = [
  '**/.env*',
  '**/*secret*',
  '**/*.key',
  '**/credentials*',
  '~/.codex/auth.json',
  '**/node_modules/**',
  'unrelated-full-logs',
  'other-work-private-traces',
];

/** The Developer output contract (mirror of developer-runtime DEVELOPER_OUTPUT_CONTRACT). */
export const DEFAULT_DEVELOPER_OUTPUT_REQUIRED: string[] = [
  'implementation_plan', 'patch_proposal', 'changed_files', 'test_plan', 'risk_notes', 'rollback_notes',
];

function dedupeInOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) { if (!seen.has(it)) { seen.add(it); out.push(it); } }
  return out;
}

/** Deterministically render a Developer Task Packet from the contract. The LLM may
 *  later enrich prose, but the enforceable structure is produced here, not guessed. */
export function composeDeveloperTaskPacket(input: DeveloperPacketInput): DeveloperTaskPacket {
  const c = input.contract;
  // A packet must render a development-ready contract. Missing essentials is a
  // contract defect, surfaced loudly (NOT a silent or stubbed packet).
  const missing = validateStoryReady({
    objective: c.objective,
    allowed_write_set: c.allowed_write_set,
    acceptance_criteria: c.acceptance_criteria,
    validation_commands: c.validation_commands,
    rollback_notes: c.rollback_notes,
  });
  if (!c.story_id) missing.unshift('story_id');
  if (missing.length > 0) {
    throw new Error(`composeDeveloperTaskPacket: contract missing required fields: ${missing.join(', ')}`);
  }

  const storyId = c.story_id as string;
  const storyContractRef = c.story_contract_ref ?? `story_contract:${storyId}`;
  const warnings = input.failureWarnings ?? [];

  // Render matching failure-bank AVOID warnings into the background prose so the
  // developer turn carries them (008.3), and also reference them in include_refs.
  const warningLines = warnings.map(
    w => `- AVOID: ${w.avoid} [signal: ${w.matching_signal}${w.consolidated_count && w.consolidated_count >= 2 ? '; recurring' : ''}]`,
  );
  const background = [
    c.background ?? `Implement story ${storyId}.`,
    warningLines.length > 0 ? `\nKnown failure patterns to avoid (from failure bank):\n${warningLines.join('\n')}` : '',
  ].join('').trim();

  const warningRefs = warnings.map(w => `failure-bank:avoid:${w.matching_signal}`);
  const includeRefs = dedupeInOrder([
    storyContractRef,
    ...(input.contextRefs ?? []),
    ...warningRefs,
  ]);

  return {
    packet_id: input.packetId ?? `TP-${storyId}`,
    story_id: storyId,
    story_contract_ref: storyContractRef,
    ...(c.contract_version !== undefined ? { contract_version: c.contract_version } : {}),
    target_agent: 'developer',
    task_title: c.task_title ?? `Implement ${storyId}`,
    task_goal: c.objective as string,
    task_details: {
      background,
      expected_behavior: c.expected_behavior ?? (c.acceptance_criteria as string[]),
      non_goals: c.non_goals ?? [],
    },
    allowed_write_set: c.allowed_write_set as string[],
    forbidden_actions: c.forbidden_actions ?? [
      'no writes outside the allowed write-set',
      'no reading secrets/.env/credential files',
      'no sudo or privilege escalation',
      'no deleting or weakening existing tests',
      'no removing existing behavior when modifying a shared file (additive at the line level)',
    ],
    required_files: {
      create: c.required_files?.create ?? [],
      update: c.required_files?.update ?? [],
      do_not_touch: c.required_files?.do_not_touch ?? [],
    },
    validation_commands: c.validation_commands as string[],
    acceptance_criteria: c.acceptance_criteria as string[],
    rollback_requirement: {
      required: true,
      expected_content: c.rollback_notes ? [c.rollback_notes] : ['how to revert this change'],
    },
    context_packet: {
      include_refs: includeRefs,
      exclude_patterns: input.excludePatterns ?? DEFAULT_PACKET_EXCLUDE_PATTERNS,
    },
    output_required: input.outputRequired ?? DEFAULT_DEVELOPER_OUTPUT_REQUIRED,
    // §1a: ALWAYS carry the preserve-existing-behavior directive (never collapse it).
    behavior_preservation: BEHAVIOR_PRESERVATION_DIRECTIVE,
    // WORK B: deterministic task signals for the router (domain + context need).
    task_signals: inferTaskSignals({ allowed_write_set: c.allowed_write_set, estimated_complexity: c.estimated_complexity }),
    ...(c.estimated_complexity !== undefined ? { estimated_complexity: c.estimated_complexity } : {}),
  };
}
// ── Debugger Task Packet composition (STORY-029.4) ───────────────────────────
// The second joint: turn a validation failure plus the failing diff into a
// debugger task packet — the failure gene, the local diff under repair, the
// acceptance that failed, and do-not-touch guardrails. LOCAL scope by design
// (this story, this failure); widening requires Supervisor + human approval.

/** The validation failure being handed to the Debugger. */
export interface FailingValidation {
  failed_command?: string;
  failure_signature?: string;
  validation_report_ref?: string;
  failed_logs_ref?: string;
  /** The acceptance criteria that failed (subset of the contract's). */
  failed_acceptance?: string[];
}

/** The local diff currently under repair. */
export interface LocalDiff {
  changed_files: string[];
  current_patch_ref?: string;
}

export interface DebuggerPacketInput {
  contract: StoryContractForPacket;
  failure: FailingValidation;
  diff: LocalDiff;
  /** The failure gene (008.3/008.4); its AVOID is the operative guardrail. */
  gene?: FailureBankWarning;
  /** Human-issue intake: investigate/reproduce only, no repair until reproducible. */
  investigationOnly?: boolean;
  contextRefs?: string[];
  excludePatterns?: string[];
  packetId?: string;
}

export interface DebuggerTaskPacket {
  packet_id: string;
  story_id: string;
  story_contract_ref: string;
  contract_version?: number;
  target_agent: 'debugger';
  debug_goal: string;
  investigation_only: boolean;
  failure_context: {
    validation_report_ref?: string;
    failed_command?: string;
    failure_signature?: string;
    failed_logs_ref?: string;
    changed_files: string[];
    current_patch_ref?: string;
  };
  allowed_repair_scope: string[];
  forbidden_actions: string[];
  required_analysis: string[];
  /** The operative AVOID gene, or null for a fresh failure. */
  failure_gene: { matching_signal: string; avoid: string; consolidated_count?: number } | null;
  /** The acceptance criteria that failed (carried for the Debugger to re-satisfy). */
  acceptance_that_failed: string[];
  /** Explicit do-not-touch guardrails beyond the allowed repair scope. */
  do_not_touch: string[];
  context_packet: { include_refs: string[]; exclude_patterns: string[] };
  output_required: string[];
}

export const DEFAULT_REQUIRED_ANALYSIS: string[] = [
  'failure_classification', 'root_cause', 'affected_subgraph', 'minimal_repair_plan', 'whether_scope_expansion_is_needed',
];

/** Structured outputs a Debugger turn must return (mirror of agent-output debugger kinds). */
export const DEFAULT_DEBUGGER_OUTPUT_REQUIRED: string[] = [
  'repair_proposal_or_escalation', 'root_cause', 'failure_gene',
];

/** Deterministically render a Debugger Task Packet from a failure + the local diff. */
export function composeDebuggerTaskPacket(input: DebuggerPacketInput): DebuggerTaskPacket {
  const c = input.contract;
  if (!c.story_id) throw new Error('composeDebuggerTaskPacket: contract missing required field: story_id');
  const storyId = c.story_id;
  const storyContractRef = c.story_contract_ref ?? `story_contract:${storyId}`;

  // LOCAL scope: repair is confined to the files in the failing diff. If the diff
  // is somehow empty, fall back to the story's own write-set — never wider.
  const allowedRepairScope = input.diff.changed_files.length > 0
    ? dedupeInOrder(input.diff.changed_files)
    : (c.allowed_write_set ?? []);

  const failedAcceptance = input.failure.failed_acceptance ?? [];
  const sig = input.failure.failure_signature ?? input.failure.failed_command ?? 'unknown failure';

  const debugGoal = input.investigationOnly
    ? `Investigate and reproduce the reported issue on ${storyId} (${sig}). Investigation only — no repair until a reproducible defect is confirmed.`
    : `Repair the local failure on ${storyId} (${sig}) so the failed acceptance passes again, WITHOUT widening scope beyond the diff under repair.`;

  // Do-not-touch guardrails: anything outside the local repair scope, plus the
  // invariants every turn must honor.
  const doNotTouch = dedupeInOrder([
    'any file outside allowed_repair_scope',
    'existing tests (never delete or weaken them)',
    'secrets / .env / credential files',
    'the story contract (scope widening needs Supervisor + human approval)',
  ]);

  const forbiddenActions = dedupeInOrder([
    'do not widen the repair beyond allowed_repair_scope',
    'do not delete or weaken existing tests',
    'no reading secrets/.env/credential files',
    'no sudo or privilege escalation',
    'no real provider or network API calls',
  ]);

  const geneRef = input.gene ? [`failure-bank:avoid:${input.gene.matching_signal}`] : [];
  const reportRef = input.failure.validation_report_ref ? [input.failure.validation_report_ref] : [];
  const includeRefs = dedupeInOrder([
    storyContractRef,
    ...reportRef,
    ...geneRef,
    ...(input.contextRefs ?? []),
  ]);

  return {
    packet_id: input.packetId ?? `TP-DBG-${storyId}`,
    story_id: storyId,
    story_contract_ref: storyContractRef,
    ...(c.contract_version !== undefined ? { contract_version: c.contract_version } : {}),
    target_agent: 'debugger',
    debug_goal: debugGoal,
    investigation_only: input.investigationOnly ?? false,
    failure_context: {
      ...(input.failure.validation_report_ref !== undefined ? { validation_report_ref: input.failure.validation_report_ref } : {}),
      ...(input.failure.failed_command !== undefined ? { failed_command: input.failure.failed_command } : {}),
      ...(input.failure.failure_signature !== undefined ? { failure_signature: input.failure.failure_signature } : {}),
      ...(input.failure.failed_logs_ref !== undefined ? { failed_logs_ref: input.failure.failed_logs_ref } : {}),
      changed_files: input.diff.changed_files,
      ...(input.diff.current_patch_ref !== undefined ? { current_patch_ref: input.diff.current_patch_ref } : {}),
    },
    allowed_repair_scope: allowedRepairScope,
    forbidden_actions: forbiddenActions,
    required_analysis: DEFAULT_REQUIRED_ANALYSIS,
    failure_gene: input.gene
      ? { matching_signal: input.gene.matching_signal, avoid: input.gene.avoid, ...(input.gene.consolidated_count !== undefined ? { consolidated_count: input.gene.consolidated_count } : {}) }
      : null,
    acceptance_that_failed: failedAcceptance,
    do_not_touch: doNotTouch,
    context_packet: {
      include_refs: includeRefs,
      exclude_patterns: input.excludePatterns ?? DEFAULT_PACKET_EXCLUDE_PATTERNS,
    },
    output_required: DEFAULT_DEBUGGER_OUTPUT_REQUIRED,
  };
}
// ── Progress summary (STORY-029.6) ───────────────────────────────────────────
// After each cycle the Supervisor emits a compact, trace-recorded progress
// summary (story, attempt, validation result, next action) that feeds console
// narration and the Developer's prior-story carryover (023.4). Read-only — the
// Supervisor never writes the tracker. Deterministic, and by construction it
// CANNOT leak a raw transcript: only whitelisted fields are read, and free-text
// fields are redacted for secret-like tokens.

/** One cycle's state, as read from the tracker. Extra fields are tolerated but
 *  NEVER copied wholesale into the summary (no raw transcript / log leakage). */
export interface ProgressCycleInput {
  story_id: string;
  epic_id?: string;
  attempt?: number;
  attempt_budget?: number | null;
  validation_result?: string;   // 'pass' | 'fail' | 'pending' | ...
  status?: string;
  last_action?: string;
  next_action?: string;
  [k: string]: unknown;
}

/** The compact, trace-recordable summary event. */
export interface ProgressSummaryEvent {
  event_type: 'progress_summary';
  story_id: string;
  epic_id: string | null;
  attempt: number;
  attempt_budget: number | null;
  validation_result: string;
  status: string | null;
  next_action: string;
  /** One-line narration for the console and carryover. */
  summary: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]+/gi,
  /\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,
  /\beyJ[A-Za-z0-9._-]{10,}\b/g, // JWT-ish
];

/** Redact secret-like tokens from a free-text field. Whitelisting already keeps
 *  raw transcripts out; this guards the short fields we DO surface. */
function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Compact, trace-recorded progress summary for one cycle. Read-only; deterministic. */
export function summarizeProgress(cycle: ProgressCycleInput): ProgressSummaryEvent {
  if (!cycle.story_id) throw new Error('summarizeProgress: cycle missing required field: story_id');

  const attempt = typeof cycle.attempt === 'number' ? cycle.attempt : 0;
  const attemptBudget = typeof cycle.attempt_budget === 'number' ? cycle.attempt_budget : null;
  const validation = typeof cycle.validation_result === 'string' ? cycle.validation_result : 'pending';
  const status = typeof cycle.status === 'string' ? cycle.status : null;
  const nextAction = redactSecrets(typeof cycle.next_action === 'string' ? cycle.next_action : 'awaiting next artifact');
  const epicId = typeof cycle.epic_id === 'string' ? cycle.epic_id : null;

  const budgetStr = attemptBudget !== null ? `/${attemptBudget}` : '';
  const summary = redactSecrets(
    `${cycle.story_id}: attempt ${attempt}${budgetStr}, validation ${validation} → next: ${nextAction}`,
  );

  return {
    event_type: 'progress_summary',
    story_id: cycle.story_id,
    epic_id: epicId,
    attempt,
    attempt_budget: attemptBudget,
    validation_result: validation,
    status,
    next_action: nextAction,
    summary,
  };
}

// ── STORY-032.1: composed task packets conform to their JSON envelope ──────────
//
// The Supervisor composes the developer/debugger task packets (029.2/029.4); those
// are the request envelopes validated on the wire (032.1). This check confirms the
// composed packet carries every field its envelope requires — schema-driven (the
// required list is read from specs/agent_envelope/, so it cannot drift from the
// schema). Design: docs/architecture/16_MODEL_REGISTRY_AND_INTROSPECTION.md.

const ENVELOPE_SCHEMA_DIR = fileURLToPath(new URL('../../../specs/agent_envelope/', import.meta.url));

function readEnvelopeSchema(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(`${ENVELOPE_SCHEMA_DIR}${name}.schema.json`, 'utf8'));
}

/**
 * STORY-032.1: return the envelope-conformance errors for a composed task packet
 * (missing required fields, or a wrong target_agent const). Empty = conforms.
 */
export function taskPacketEnvelopeErrors(packet: Record<string, unknown>, schemaName: string): string[] {
  const schema = readEnvelopeSchema(schemaName);
  const errors: string[] = [];
  for (const req of (schema.required ?? []) as string[]) {
    if (packet[req] === undefined) errors.push(`missing required envelope field: ${req}`);
  }
  const constAgent = schema.properties?.target_agent?.const;
  if (constAgent !== undefined && packet.target_agent !== constAgent) {
    errors.push(`target_agent must be '${constAgent}'`);
  }
  return errors;
}
