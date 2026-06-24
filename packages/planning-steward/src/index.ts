import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeImpactSet, NULL_CLIENT } from '@gateloop/codegraph-adapter';
import type { CodeGraphClient } from '@gateloop/codegraph-adapter';
import { extractProjectProfile } from '@gateloop/context-manager';
import type { ProjectProfile } from '@gateloop/context-manager';

// STORY-PFLOW.2: Planning Workflow config schema + deterministic loader.
// STORY-PFLOW.3: Planning Workflow state machine (status + order enforcement).
export type {
  PlanningWorkflowStage,
  PlanningWorkflowConfig,
  StageStatus,
  FlowStageSnapshot,
  PlanningFlowState,
  StageOrderingProof,
} from './workflow.js';
export {
  PlanningWorkflowConfigError,
  parsePlanningWorkflow,
  loadPlanningWorkflowFile,
  PlanningWorkflowStateError,
  initFlowState,
  flowSnapshot,
  activeIndex,
  isComplete,
  canActivate,
  activateStage,
  advance,
  assertStageOrderingBarrier,
} from './workflow.js';

// STORY-PSKILL.1: doc-authoring skill loader (separate registry from EPIC-014).
export type {
  DocSkillFrontmatter,
  DocSkillStep,
  DocSkill,
  StepSequencer,
} from './docskill.js';
export {
  DocSkillLoadError,
  parseSkillFrontmatter,
  loadDocSkill,
  // STORY-PSKILL.2: just-in-time step sequencer
  StepSequencerError,
  initStepSequencer,
  totalSteps,
  stepPosition,
  currentStep,
  atLastStep,
  isAuthoringStepComplete,
  nextStep,
} from './docskill.js';

// STORY-PSKILL.3: completion checker (checklist.md → passed/total).
export type { ChecklistItem, ChecklistResult } from './checklist.js';
export { parseChecklist, evaluateChecklist } from './checklist.js';

export type IdeaMode = 'greenfield' | 'brownfield' | 'patch' | 'checkpoint' | 'research_spike';

export interface IdeaInput {
  title: string;
  description: string;
  source?: 'user' | 'oss_reference' | 'brownfield_repo' | 'bug_report';
  idea_id?: string;
  goals?: string[];
  non_goals?: string[];
  constraints?: string[];
  target_users?: string[];
  source_refs?: string[];
}

// ── STORY-019.4: Prompt-injection detection ───────────────────────────────────

export interface InjectionDetectionResult {
  detected: boolean;
  signals: string[];
}

const INJECTION_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'role_prefix_SYSTEM',      re: /SYSTEM:/i },
  { label: 'role_prefix_USER',        re: /USER:/i },
  { label: 'role_prefix_ASSISTANT',   re: /ASSISTANT:/i },
  { label: 'special_token_im_start',  re: /<\|im_start\|>/i },
  { label: 'special_token_im_end',    re: /<\|im_end\|>/i },
  { label: 'special_token_endoftext', re: /<\|endoftext\|>/i },
  { label: 'ignore_previous',         re: /ignore\s+previous\s+instructions/i },
  { label: 'ignore_all_previous',     re: /ignore\s+all\s+previous/i },
  { label: 'disregard_above',         re: /disregard\s+above/i },
  { label: 'roleplay_pretend',        re: /pretend\s+you\s+are/i },
  { label: 'roleplay_act_as',         re: /act\s+as\s+if\s+you\s+are/i },
  { label: 'roleplay_you_are_now',    re: /you\s+are\s+now/i },
  { label: 'write_set_widening',      re: /write\s+to\s+\//i },
  { label: 'bypass_workspace',        re: /bypass_workspace/i },
  { label: 'policy_write_set',        re: /allowed_write_set:/i },
];

export function detectPromptInjection(text: string): InjectionDetectionResult {
  const signals: string[] = [];
  for (const { label, re } of INJECTION_PATTERNS) {
    if (re.test(text)) signals.push(label);
  }
  return { detected: signals.length > 0, signals };
}

export function classifyIdea(input: IdeaInput): IdeaMode {
  const combined = `${input.title} ${input.description}`;
  if (detectPromptInjection(combined).detected) {
    throw new Error('idea_rejected: prompt injection detected');
  }
  const text = combined.toLowerCase();
  if (input.source === 'oss_reference' || text.includes('github.com')) return 'research_spike';
  if (text.includes('checkpoint') || text.includes('freeze')) return 'checkpoint';
  if (input.source === 'bug_report' || text.includes('bug') || text.includes('fix')) return 'patch';
  if (input.source === 'brownfield_repo' || text.includes('integrate') || text.includes('existing')) return 'brownfield';
  return 'greenfield';
}

export function requiredPlanningFiles(): string[] {
  return [
    '00_idea_record.md',
    '01_classification.md',
    '02_required_documents.md',
    '03_epic_story_graph.md',
    '04_parallelism_plan.md',
    '05_integration_plan.md',
    '06_rollback_plan.md',
    '07_context_compaction_plan.md',
    '08_supervisor_contract_draft.md',
    '09_acceptance_checklist.md'
  ];
}

// ── bundle assembly + graph (deterministic parts real; authoring is later) ───
export interface ValidationResult { ok: boolean; errors: string[] }

/** A planning bundle is complete only if every required file is present. */
export function validatePlanningBundle(presentFiles: string[]): ValidationResult {
  const missing = requiredPlanningFiles().filter(f => !presentFiles.includes(f)).map(f => `missing bundle file: ${f}`);
  return { ok: missing.length === 0, errors: missing };
}

// ── STORY-020.2: Task-class-aware planning bundles ───────────────────────────

export type TaskClass = 'greenfield' | 'brownfield' | 'patch';

export interface PublicApiConstraint {
  frozen_paths: string[];
  reason: string;
}

export interface BrownfieldDelta {
  file: string;
  affected_symbols: string[];
  change_intent: string;
}

export interface AmbiguityQuestion {
  id: string;
  text: string;
  type: 'text' | 'choice';
  required: boolean;
}

export interface StoryNode {
  story_id: string;
  depends_on: string[];
  allowed_write_set: string[];
  parallelism_class?: string;
  task_class?: TaskClass;
  public_api_constraint?: PublicApiConstraint;
  brownfield_deltas?: BrownfieldDelta[];
  ambiguity_questions?: AmbiguityQuestion[];
  has_frontend_stage?: boolean | null;
}

/** Two stories conflict for parallel run if their write-sets intersect (glob prefix check). */
export function detectParallelismConflict(a: StoryNode, b: StoryNode): boolean {
  const norm = (g: string) => g.replace(/\*+$/, '');
  return a.allowed_write_set.some(x => b.allowed_write_set.some(y =>
    norm(x).startsWith(norm(y)) || norm(y).startsWith(norm(x))));
}
/** Topological readiness: stories whose deps are all in `done`. */
export function selectableStories(stories: StoryNode[], done: Set<string>): StoryNode[] {
  return stories.filter(s => s.depends_on.every(d => done.has(d)));
}

/**
 * STORY-020.2: Emit structured ambiguity questions for brownfield stories whose
 * deltas affect symbols that already exist in the codebase.
 */
export function emitAmbiguityQuestions(
  story: StoryNode,
  existingSymbols: string[],
): AmbiguityQuestion[] {
  if (story.task_class !== 'brownfield') return [];
  const symbolSet = new Set(existingSymbols);
  const questions: AmbiguityQuestion[] = [];
  for (const delta of story.brownfield_deltas ?? []) {
    for (const sym of delta.affected_symbols) {
      if (symbolSet.has(sym)) {
        questions.push({
          id: `ambiguity_${sym}`,
          text: `Is the current behavior of ${sym} intentional? The patch may change it.`,
          type: 'text',
          required: true,
        });
      }
    }
  }
  return questions;
}

// ── PlanningBundle types ─────────────────────────────────────────────────────

export interface PlanningBundlePrd {
  title: string;
  problem_statement: string;
  users: string[];
  goals: string[];
  non_goals: string[];
}

export interface PlanningBundleArchitecture {
  summary: string;
  components: string[];
  constraints: string[];
  risks: string[];
}

export interface OpenDecision {
  id: string;
  question: string;
  options: Array<{ option_id: string; tradeoff: string }>;
}

export interface PlanningBundle {
  bundle_id: string;
  idea_id: string;
  prd: PlanningBundlePrd;
  architecture: PlanningBundleArchitecture;
  open_decisions: OpenDecision[];
  source_refs: string[];
}

// ── createPlanningBundle implementation ─────────────────────────────────────

const SECRET_RE = /\b(?:password|api[-_]key|secret[-_]key|auth[-_]token|access[-_]key|private[-_]key|bearer)\s*[:=]/i;

function collectInputStrings(input: IdeaInput): string[] {
  return [
    input.title,
    input.description,
    ...(input.goals ?? []),
    ...(input.non_goals ?? []),
    ...(input.constraints ?? []),
    ...(input.target_users ?? []),
    ...(input.source_refs ?? []),
  ];
}

function rejectSecrets(fields: string[]): void {
  for (const f of fields) {
    if (SECRET_RE.test(f)) {
      throw new Error(`planning bundle: input contains secret-like content`);
    }
  }
}

function deriveIdeaId(title: string): string {
  const id = title.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return id || 'unnamed';
}

const ARCH_BY_MODE: Record<IdeaMode, { summary: string; components: string[]; risks: string[] }> = {
  greenfield: {
    summary: 'New standalone system; independent module boundaries apply.',
    components: ['core-module', 'api-layer', 'test-harness'],
    risks: ['scope creep on unplanned dependencies'],
  },
  brownfield: {
    summary: 'Integration with existing system; adapter layer required.',
    components: ['adapter-layer', 'integration-tests', 'migration-script'],
    risks: ['integration surface may require migration', 'existing test coverage unknown'],
  },
  patch: {
    summary: 'Targeted fix within existing module; minimal change surface.',
    components: ['target-module', 'regression-tests'],
    risks: ['fix may introduce regressions in adjacent code'],
  },
  checkpoint: {
    summary: 'State snapshot and promotion gate; no new feature surface.',
    components: ['checkpoint-validator', 'promotion-gate'],
    risks: ['promotion gate failure may block downstream stories'],
  },
  research_spike: {
    summary: 'Time-boxed investigation; output is a report, not production code.',
    components: ['research-document', 'prototype-optional'],
    risks: ['findings may not translate directly to implementation'],
  },
};

/**
 * STORY-009.1: Deterministic planning bundle builder.
 * Takes a structured idea input and produces a PRD + architecture sketch.
 * Emits ambiguities as structured open decisions (escalation schema).
 * No LLM, no external API, no secret reads; caller may inject idea_id for full determinism.
 */
export function createPlanningBundle(input: IdeaInput): PlanningBundle {
  if (!input.title?.trim()) throw new Error('planning bundle: title is required');
  if (!input.description?.trim()) throw new Error('planning bundle: description is required');

  rejectSecrets(collectInputStrings(input));

  const mode = classifyIdea(input);
  const idea_id = (input.idea_id ?? '').trim() || deriveIdeaId(input.title);
  const bundle_id = `bundle-${idea_id}`;

  // Sort all array fields for deterministic output ordering
  const goals = [...(input.goals ?? [])].sort();
  const non_goals = [...(input.non_goals ?? [])].sort();
  const constraints = [...(input.constraints ?? [])].sort();
  const target_users = [...(input.target_users ?? [])].sort();
  const source_refs = [...(input.source_refs ?? [])].sort();

  const arch = ARCH_BY_MODE[mode];

  // Detect ambiguities → structured open decisions (escalation-schema option_id+tradeoff)
  const open_decisions: OpenDecision[] = [];
  if (goals.length === 0) {
    open_decisions.push({
      id: 'od-1',
      question: 'What are the primary goals for this idea?',
      options: [
        { option_id: 'defer', tradeoff: 'Defer goal authoring to Planning Steward PRD review.' },
        { option_id: 'freeform', tradeoff: 'Author free-form goals in idea fixture before story generation.' },
      ],
    });
  }
  if (target_users.length === 0) {
    open_decisions.push({
      id: 'od-2',
      question: 'Who are the target users or actors?',
      options: [
        { option_id: 'defer', tradeoff: 'Defer user identification to PRD author.' },
        { option_id: 'freeform', tradeoff: 'Specify users in idea fixture before story generation.' },
      ],
    });
  }
  if (constraints.length === 0) {
    open_decisions.push({
      id: 'od-3',
      question: 'What technical or business constraints apply?',
      options: [
        { option_id: 'none', tradeoff: 'No constraints at this stage; accept risks.' },
        { option_id: 'defer', tradeoff: 'Defer constraint analysis to architecture review.' },
      ],
    });
  }

  return {
    bundle_id,
    idea_id,
    prd: {
      title: input.title.trim(),
      problem_statement: input.description.trim(),
      users: target_users,
      goals,
      non_goals,
    },
    architecture: {
      summary: arch.summary,
      components: [...arch.components],
      constraints,
      risks: [...arch.risks],
    },
    open_decisions,
    source_refs,
  };
}

// ── STORY-009.2: generateBacklogFromPlanningBundle ───────────────────────────

export type GeneratedEpic = {
  epic_id: string;
  title: string;
  objective: string;
  depends_on: string[];
  exit_criteria: string[];
};

export type GeneratedStory = {
  story_id: string;
  epic_id: string;
  title: string;
  objective: string;
  depends_on: string[];
  parallelism_class: 'parallel_safe' | 'parallel_with_barrier' | 'sequential';
  allowed_write_set: string[];
  forbidden_actions: string[];
  acceptance_criteria: Record<string, unknown>;
  /** STORY-030.1: testable "done" intent, authored at planning time (before code). */
  acceptance_intent: AcceptanceIntent;
  validation_commands: string[];
  rollback_notes: string[];
  /** §3: the 7th contract element — the context packet (what the Developer is given,
   *  what is excluded). Authored deterministically at planning time so every story is
   *  development-ready with a complete contract before code begins. */
  context_packet: { include_refs: string[]; exclude_patterns: string[] };
  /** WORK 3a: deterministically-estimated complexity — the signal the deterministic
   *  router uses to pick a model. Authored here (no LLM), so it is reproducible. */
  estimated_complexity: StoryComplexity;
};

/** Story complexity tiers (mirror specs/story_contract.schema.json estimated_complexity). */
export type StoryComplexity = 'trivial' | 'small' | 'medium' | 'large' | 'xlarge';

/**
 * WORK 3a: estimate a story's complexity DETERMINISTICALLY (no LLM) from observable
 * contract size — files in the write-set and the number of acceptance behaviors.
 * Same inputs → same tier, so the router's choice is reproducible.
 */
export function estimateStoryComplexity(input: { allowed_write_set?: string[]; behaviorCount?: number }): StoryComplexity {
  const files = input.allowed_write_set?.length ?? 0;
  const behaviors = input.behaviorCount ?? 0;
  const score = files * 2 + behaviors;
  if (score <= 2) return 'trivial';
  if (score <= 5) return 'small';
  if (score <= 9) return 'medium';
  if (score <= 14) return 'large';
  return 'xlarge';
}

export type GeneratedBacklog = {
  source_bundle_id: string;
  epics: GeneratedEpic[];
  stories: GeneratedStory[];
};

// ── STORY-030.1: Acceptance intent (Layer 1 — Planning authors testable intent) ─
//
// Every generated story carries an acceptance_intent: the behaviours that define
// "done", expressed as testable items (not prose), authored at planning time —
// before any code exists, so there is nothing to over-fit to. The Assessor
// (STORY-030.3) turns this intent into concrete tests; the bundle gate rejects a
// story that lacks it. Design: docs/agents/07_AGENT_REFACTOR_GENERATION_VS_ASSESSMENT.md.

export type AcceptanceIntentKind = 'behavior' | 'file_exists' | 'command';

export interface AcceptanceIntentItem {
  /** snake_case testable identifier — never a prose sentence. */
  id: string;
  kind: AcceptanceIntentKind;
  /** behaviour name, file path, or command string the item checks. */
  target: string;
}

export interface AcceptanceIntent {
  /** Authored at planning time, before any code exists (nothing to over-fit). */
  authored_at: 'planning';
  behaviors: AcceptanceIntentItem[];
}

/** snake_case identifier: lowercase words joined by single underscores, no prose. */
const TESTABLE_ID_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function slugifyBehavior(behavior: string): string {
  return behavior.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * STORY-030.1: Derive a testable acceptance_intent from a story's
 * acceptance_criteria. Pure — planning data only, no filesystem and no code:
 * that purity is exactly why the intent can be authored before any code exists.
 */
export function deriveAcceptanceIntent(acceptance_criteria: Record<string, unknown>): AcceptanceIntent {
  const behaviors: AcceptanceIntentItem[] = [];
  const asStrings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  for (const b of asStrings(acceptance_criteria?.behaviors_must_pass)) {
    behaviors.push({ id: slugifyBehavior(b), kind: 'behavior', target: b });
  }
  for (const f of asStrings(acceptance_criteria?.files_must_exist)) {
    behaviors.push({ id: `file_exists_${slugifyBehavior(f)}`, kind: 'file_exists', target: f });
  }
  for (const c of asStrings(acceptance_criteria?.commands_must_pass)) {
    behaviors.push({ id: `command_${slugifyBehavior(c)}`, kind: 'command', target: c });
  }
  return { authored_at: 'planning', behaviors };
}

/**
 * STORY-030.1: Validate an acceptance_intent is present and testable (not prose).
 * Used by the bundle gate to reject stories without machine-checkable intent.
 */
export function validateAcceptanceIntent(intent: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof intent !== 'object' || intent === null) {
    return { ok: false, errors: ['acceptance_intent must be a non-null object'] };
  }
  const i = intent as Record<string, unknown>;
  if (i.authored_at !== 'planning') {
    errors.push('acceptance_intent.authored_at must be "planning" (authored before code exists)');
  }
  if (!Array.isArray(i.behaviors) || i.behaviors.length === 0) {
    errors.push('acceptance_intent.behaviors must be a non-empty array');
    return { ok: false, errors };
  }
  i.behaviors.forEach((raw, idx) => {
    const item = raw as Record<string, unknown>;
    if (typeof item?.id !== 'string' || !TESTABLE_ID_RE.test(item.id)) {
      errors.push(`acceptance_intent.behaviors[${idx}].id must be a snake_case testable identifier, not prose`);
    }
    if (item?.kind !== 'behavior' && item?.kind !== 'file_exists' && item?.kind !== 'command') {
      errors.push(`acceptance_intent.behaviors[${idx}].kind must be behavior|file_exists|command`);
    }
    if (typeof item?.target !== 'string' || !(item.target as string).trim()) {
      errors.push(`acceptance_intent.behaviors[${idx}].target must be a non-empty string`);
    }
  });
  return { ok: errors.length === 0, errors };
}

/**
 * STORY-030.1: Bundle gate — every story in a backlog must carry a valid,
 * testable acceptance_intent. Throws (rejects emission) on the first offender,
 * mirroring the open-decisions gate. The generator guarantees this; the gate is
 * the independent check the harness can run on any backlog or story set.
 */
export function assertStoriesCarryAcceptanceIntent(
  stories: Array<{ story_id: string; acceptance_intent?: unknown }>,
): void {
  for (const s of stories) {
    if (!('acceptance_intent' in s) || s.acceptance_intent === undefined || s.acceptance_intent === null) {
      throw new Error(`bundle_gate: story ${s.story_id} is missing acceptance_intent`);
    }
    const v = validateAcceptanceIntent(s.acceptance_intent);
    if (!v.ok) {
      throw new Error(`bundle_gate: story ${s.story_id} has invalid acceptance_intent: ${v.errors.join('; ')}`);
    }
  }
}

const STANDARD_FORBIDDEN_ACTIONS = [
  'No reading secrets, .env, or credential files',
  'No sudo or privilege escalation',
  'No real provider or network API calls (scripted/fixture only)',
  'No deleting or weakening existing tests',
  'No writes outside the allowed write-set',
];

const BUNDLE_SECRET_RE = /\b(?:password|api[-_]key|secret[-_]key|auth[-_]token|access[-_]key|private[-_]key|bearer)\s*[:=]/i;

function checkBundleForSecrets(bundle: PlanningBundle): void {
  const fields: string[] = [
    bundle.bundle_id,
    bundle.idea_id,
    bundle.prd.title,
    bundle.prd.problem_statement,
    ...bundle.prd.users,
    ...bundle.prd.goals,
    ...bundle.prd.non_goals,
    bundle.architecture.summary,
    ...bundle.architecture.components,
    ...bundle.architecture.constraints,
    ...bundle.architecture.risks,
    ...bundle.source_refs,
    ...bundle.open_decisions.map(od => od.question),
  ];
  for (const f of fields) {
    if (BUNDLE_SECRET_RE.test(f)) {
      throw new Error('generateBacklog: input contains secret-like content');
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * STORY-009.2: Deterministic backlog generator.
 * Expands a PlanningBundle into schema-valid GeneratedEpic[] and GeneratedStory[].
 * No LLM, no external API, no secret reads. Caller may inject bundle_id for
 * full determinism. Output ordering and IDs are fully deterministic.
 */
export function generateBacklogFromPlanningBundle(bundle: PlanningBundle): GeneratedBacklog {
  if (!bundle?.bundle_id?.trim()) throw new Error('generateBacklog: bundle_id is required');
  if (!bundle?.prd?.title?.trim()) throw new Error('generateBacklog: prd.title is required');
  if (!Array.isArray(bundle?.architecture?.components) || bundle.architecture.components.length === 0) {
    throw new Error('generateBacklog: architecture.components must have at least one entry');
  }
  // ambiguity_blocks_until_answered (STORY-009.3): open decisions must be resolved before emission
  if (Array.isArray(bundle.open_decisions) && bundle.open_decisions.length > 0) {
    throw new Error(`generateBacklog: bundle has ${bundle.open_decisions.length} unresolved open decision(s) — resolve before backlog emission`);
  }

  checkBundleForSecrets(bundle);

  const prefix = bundle.bundle_id;
  const components = [...bundle.architecture.components].sort();
  const baseProject = prefix.replace(/^bundle-/, '');
  const projectRoot = `packages/${baseProject}`;

  const epics: GeneratedEpic[] = [];
  // Built without acceptance_intent, then finalized below (STORY-030.1) so the
  // intent is derived once from each story's acceptance_criteria.
  const stories: Array<Omit<GeneratedStory, 'acceptance_intent' | 'context_packet' | 'estimated_complexity'>> = [];

  // Epic 01: Foundation
  const foundEpicId = `${prefix}-epic-${pad2(1)}`;
  const foundStoryId = `${prefix}-story-${pad2(1)}.1`;

  epics.push({
    epic_id: foundEpicId,
    title: `Foundation — ${bundle.prd.title}`,
    objective: `Establish project structure and shared types for: ${bundle.prd.problem_statement.slice(0, 120)}`,
    depends_on: [],
    exit_criteria: ['project_structure_exists', 'shared_types_defined', 'build_passes'],
  });

  stories.push({
    story_id: foundStoryId,
    epic_id: foundEpicId,
    title: 'Set up project structure and shared types',
    objective: 'Create the package scaffold, TypeScript config, and shared type definitions.',
    depends_on: [],
    parallelism_class: 'sequential',
    allowed_write_set: [`${projectRoot}/`],
    forbidden_actions: [...STANDARD_FORBIDDEN_ACTIONS],
    acceptance_criteria: {
      files_must_exist: [`${projectRoot}/package.json`, `${projectRoot}/tsconfig.json`],
      behaviors_must_pass: ['project_structure_exists', 'typecheck_passes'],
      commands_must_pass: ['pnpm typecheck'],
    },
    validation_commands: ['pnpm typecheck', 'pnpm test'],
    rollback_notes: [`Delete ${projectRoot}/ directory to revert project scaffold.`],
  });

  // Epics 02…N+1: one per architecture component (sorted for determinism)
  const componentTestStoryIds: string[] = [];

  components.forEach((component, idx) => {
    const epicNum = pad2(idx + 2);
    const compEpicId = `${prefix}-epic-${epicNum}`;
    const implStoryId = `${prefix}-story-${epicNum}.1`;
    const testStoryId = `${prefix}-story-${epicNum}.2`;

    epics.push({
      epic_id: compEpicId,
      title: `Implement ${component}`,
      objective: `Build and test the ${component} module for ${bundle.prd.title}.`,
      depends_on: [foundEpicId],
      exit_criteria: [
        `${component}_implements_contract`,
        `${component}_tests_pass`,
      ],
    });

    stories.push({
      story_id: implStoryId,
      epic_id: compEpicId,
      title: `Implement ${component} core`,
      objective: `Implement the primary logic and public interface for ${component}.`,
      depends_on: [foundStoryId],
      parallelism_class: 'sequential',
      allowed_write_set: [`${projectRoot}/${component}/src/`],
      forbidden_actions: [...STANDARD_FORBIDDEN_ACTIONS],
      acceptance_criteria: {
        behaviors_must_pass: [`${component}_core_implemented`, `${component}_types_exported`],
        commands_must_pass: ['pnpm typecheck'],
      },
      validation_commands: [`pnpm test --filter ${component}`, 'pnpm typecheck'],
      rollback_notes: [`Revert changes in ${projectRoot}/${component}/src/.`],
    });

    stories.push({
      story_id: testStoryId,
      epic_id: compEpicId,
      title: `Test ${component}`,
      objective: `Add unit tests covering all AC behaviors for ${component}.`,
      depends_on: [implStoryId],
      parallelism_class: 'parallel_safe',
      allowed_write_set: [`${projectRoot}/${component}/src/`],
      forbidden_actions: [...STANDARD_FORBIDDEN_ACTIONS],
      acceptance_criteria: {
        behaviors_must_pass: [`${component}_tests_added`, `${component}_ac_covered`],
        commands_must_pass: [`pnpm test --filter ${component}`, 'pnpm typecheck'],
      },
      validation_commands: [`pnpm test --filter ${component}`, 'pnpm typecheck'],
      rollback_notes: [`Revert test additions in ${projectRoot}/${component}/.`],
    });

    componentTestStoryIds.push(testStoryId);
  });

  // Final epic: Integration
  const integrationEpicNum = pad2(components.length + 2);
  const integrationEpicId = `${prefix}-epic-${integrationEpicNum}`;
  const integrationStoryId = `${prefix}-story-${integrationEpicNum}.1`;

  epics.push({
    epic_id: integrationEpicId,
    title: `Integration — ${bundle.prd.title}`,
    objective: 'Integrate all components and verify end-to-end behavior.',
    depends_on: epics.slice(1).map(e => e.epic_id),
    exit_criteria: ['all_components_integrated', 'e2e_validation_passes'],
  });

  stories.push({
    story_id: integrationStoryId,
    epic_id: integrationEpicId,
    title: 'Integration tests and end-to-end validation',
    objective: 'Add integration tests verifying all components work together as specified in the PRD.',
    depends_on: [...componentTestStoryIds],
    parallelism_class: 'sequential',
    allowed_write_set: [`${projectRoot}/`],
    forbidden_actions: [...STANDARD_FORBIDDEN_ACTIONS],
    acceptance_criteria: {
      behaviors_must_pass: ['all_components_integrated', 'e2e_tests_pass'],
      commands_must_pass: ['pnpm test', 'pnpm typecheck'],
    },
    validation_commands: ['pnpm test', 'pnpm typecheck'],
    rollback_notes: ['Revert integration test files.'],
  });

  // STORY-030.1: finalize every story with a testable acceptance_intent derived
  // from its acceptance_criteria, then self-check via the bundle gate so the
  // generator can never emit a backlog whose stories lack machine-checkable intent.
  const finalizedStories: GeneratedStory[] = stories.map(s => {
    const acceptance_intent = deriveAcceptanceIntent(s.acceptance_criteria);
    return {
      ...s,
      acceptance_intent,
      // §3: author the 7th contract element deterministically, so every story is
      // development-ready with a COMPLETE contract before any code exists.
      context_packet: buildStoryContextPacket(s),
      // WORK 3a: deterministic complexity signal for the router.
      estimated_complexity: estimateStoryComplexity({
        allowed_write_set: s.allowed_write_set,
        behaviorCount: acceptance_intent.behaviors.length,
      }),
    };
  });
  assertStoriesCarryAcceptanceIntent(finalizedStories);
  // §3 bundle gate: the generator can never emit a story with an incomplete contract.
  assertStoriesCarryFullContract(finalizedStories);

  return {
    source_bundle_id: prefix,
    epics,
    stories: finalizedStories,
  };
}

// ── §3: Contract-first — the 7th element (context packet) + full-contract gate ──
// Planning is the Contract Compiler: every story must carry a COMPLETE contract
// (objective · acceptance_intent · allowed_write_set · forbidden_actions ·
// validation_commands · rollback_notes · context_packet) before development. The
// context packet is authored deterministically here (no LLM); the full-contract
// gate rejects any story missing an element — "legislate before executing".

/** Secrets / noise never handed to a Developer in a context packet. */
export const CONTEXT_EXCLUDE_PATTERNS: string[] = [
  '**/.env*', '**/*secret*', '**/*.key', '**/credentials*', '~/.codex/auth.json',
  '**/node_modules/**', 'unrelated-full-logs', 'other-work-private-traces',
];

/** Deterministically author a story's context packet (the 7th contract element). */
export function buildStoryContextPacket(story: { story_id: string; epic_id: string }): { include_refs: string[]; exclude_patterns: string[] } {
  return {
    include_refs: [`story_contract:${story.story_id}`, `epic:${story.epic_id}`],
    exclude_patterns: [...CONTEXT_EXCLUDE_PATTERNS],
  };
}

/** The seven contract elements every development-ready story must carry. */
export const CONTRACT_ELEMENTS = [
  'objective', 'acceptance_intent', 'allowed_write_set', 'forbidden_actions',
  'validation_commands', 'rollback_notes', 'context_packet',
] as const;

/** §3: return the contract elements a story is MISSING ([] = complete & development-ready). */
export function validateStoryContractComplete(story: Partial<GeneratedStory>): string[] {
  const missing: string[] = [];
  if (typeof story.objective !== 'string' || !story.objective.trim()) missing.push('objective');
  if (!story.acceptance_intent || validateAcceptanceIntent(story.acceptance_intent).errors.length > 0) missing.push('acceptance_intent');
  if (!Array.isArray(story.allowed_write_set) || story.allowed_write_set.length === 0) missing.push('allowed_write_set');
  if (!Array.isArray(story.forbidden_actions) || story.forbidden_actions.length === 0) missing.push('forbidden_actions');
  if (!Array.isArray(story.validation_commands) || story.validation_commands.length === 0) missing.push('validation_commands');
  if (!Array.isArray(story.rollback_notes) || story.rollback_notes.length === 0) missing.push('rollback_notes');
  const cp = story.context_packet;
  if (!cp || !Array.isArray(cp.include_refs) || cp.include_refs.length === 0 || !Array.isArray(cp.exclude_patterns)) missing.push('context_packet');
  return missing;
}

/** §3 bundle gate: reject emission if any story lacks a complete 7-element contract.
 *  Mirrors assertStoriesCarryAcceptanceIntent — throws on the first incomplete story. */
export function assertStoriesCarryFullContract(stories: Array<Partial<GeneratedStory> & { story_id: string }>): void {
  for (const s of stories) {
    const missing = validateStoryContractComplete(s);
    if (missing.length > 0) {
      throw new Error(`bundle_gate: story ${s.story_id} has an incomplete contract — missing: ${missing.join(', ')}`);
    }
  }
}

/** Build the story DAG from a planning bundle. Returns StoryNode[] for scheduler use. */
export function buildStoryGraph(bundle: PlanningBundle): StoryNode[] {
  const backlog = generateBacklogFromPlanningBundle(bundle);
  return backlog.stories.map(s => ({
    story_id: s.story_id,
    depends_on: s.depends_on,
    allowed_write_set: s.allowed_write_set,
    parallelism_class: s.parallelism_class,
  }));
}

// ── STORY-019.1: DefectReport schema, validation, and sanitization ────────────

export interface DefectReport {
  report_id: string;
  title: string;
  what_broke: string;
  expected_behaviour: string;
  actual_behaviour: string;
  artifact_version: string;
  reported_at: string;
  story_id?: string | null;
  reproduction_steps?: string | null;
  severity?: 'critical' | 'high' | 'medium' | 'low' | null;
}

const REQUIRED_DEFECT_FIELDS = [
  'report_id', 'title', 'what_broke', 'expected_behaviour',
  'actual_behaviour', 'artifact_version', 'reported_at',
] as const;

const DEFECT_FIELD_LIMITS: Record<string, number> = {
  title: 120,
  what_broke: 2000,
  expected_behaviour: 2000,
  actual_behaviour: 2000,
  reproduction_steps: 5000,
};

export function validateDefectReport(report: unknown): ValidationResult {
  if (typeof report !== 'object' || report === null) {
    return { ok: false, errors: ['defect report must be a non-null object'] };
  }
  const r = report as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_DEFECT_FIELDS) {
    if (typeof r[field] !== 'string' || !(r[field] as string).trim()) {
      errors.push(`missing or empty required field: ${field}`);
    }
  }

  for (const [field, limit] of Object.entries(DEFECT_FIELD_LIMITS)) {
    if (typeof r[field] === 'string' && (r[field] as string).length > limit) {
      errors.push(`field ${field} exceeds ${limit} character limit`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function sanitizeDefectText(text: string): string {
  return text
    .replace(/SYSTEM:|USER:|ASSISTANT:|<\|im_start\|>/gi, '')
    .replace(/[<>&]/g, '');
}

// ── STORY-019.2: Defect triage — classify, reproduce, emit repair story ────────

export type DefectClass = 'regression' | 'environment' | 'user_error' | 'unknown';

const SHA_RE = /^[0-9a-f]{7,}$/i;

export function classifyDefect(report: DefectReport): DefectClass {
  const version = (report.artifact_version ?? '').trim();
  const broke = (report.what_broke ?? '').toLowerCase();
  const expected = (report.expected_behaviour ?? '').toLowerCase();

  if (/environment|config|env var/i.test(broke)) return 'environment';
  if (/documentation|misunderstood/i.test(broke) || /documentation|misunderstood/i.test(expected)) return 'user_error';
  if (SHA_RE.test(version)) return 'regression';
  return 'unknown';
}

export type ReproductionStatus = 'confirmed' | 'non_reproducible' | 'error';

export interface ReproductionResult {
  status: ReproductionStatus;
  output: string;
  run_at: string;
}

export interface TestRunner {
  run(command: string): Promise<{ ok: boolean; output: string }>;
}

export async function attemptReproduction(
  _report: DefectReport,
  command: string,
  runner: TestRunner,
): Promise<ReproductionResult> {
  const run_at = new Date().toISOString();
  try {
    const result = await runner.run(command);
    return {
      status: result.ok ? 'non_reproducible' : 'confirmed',
      output: result.output,
      run_at,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'error', output: msg, run_at };
  }
}

export interface RepairStoryOptions {
  report: DefectReport;
  defectClass: DefectClass;
  reproduction: ReproductionResult;
  impactedFiles?: string[];
}

export function buildRepairStory(opts: RepairStoryOptions): StoryNode {
  if (opts.reproduction.status === 'non_reproducible') {
    throw new Error('repair_story_blocked: defect is non_reproducible');
  }
  const writeSet = opts.impactedFiles && opts.impactedFiles.length > 0
    ? [...new Set(opts.impactedFiles)].sort()
    : ['src/**'];
  return {
    story_id: 'STORY-REPAIR-' + opts.report.report_id,
    depends_on: [],
    parallelism_class: 'sequential',
    allowed_write_set: writeSet,
    task_class: 'brownfield' as TaskClass,
  };
}

export interface DefectTriageResult {
  report: DefectReport;
  defect_class: DefectClass;
  reproduction: ReproductionResult;
  repair_story: StoryNode | null;
  triage_blocked: boolean;
  triage_blocked_reason?: string;
}

export async function triageDefect(
  report: DefectReport,
  command: string,
  runner: TestRunner,
  impactedFiles?: string[],
): Promise<DefectTriageResult> {
  const defect_class = classifyDefect(report);
  const reproduction = await attemptReproduction(report, command, runner);

  if (reproduction.status === 'non_reproducible') {
    return {
      report,
      defect_class,
      reproduction,
      repair_story: null,
      triage_blocked: true,
      triage_blocked_reason: 'non_reproducible',
    };
  }

  const repair_story = buildRepairStory({ report, defectClass: defect_class, reproduction, impactedFiles });
  return { report, defect_class, reproduction, repair_story, triage_blocked: false };
}

// ── STORY-020.1: Brownfield mode entry — repo import and as-is recovery ────────

export interface BrownfieldLayer {
  name: string;
  paths: string[];
}

export interface BrownfieldIntake {
  intake_id: string;
  repo_path: string;
  intake_at: string;
  entry_points: string[];
  layers: BrownfieldLayer[];
  dependency_map: Record<string, string[]>;
  conventions: Record<string, unknown>;
  recovery_docs_path: string;
}

export interface BrownfieldImportOptions {
  repoPath: string;
  outputPath: string;
  codegraphClient?: CodeGraphClient;
  extractProfile?: (path: string) => ProjectProfile;
}

function discoverEntryPoints(repoPath: string): string[] {
  const candidates: string[] = [];
  try {
    const pkgRaw = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    if (typeof pkg.main === 'string') candidates.push(pkg.main);
    if (typeof pkg.bin === 'string') candidates.push(pkg.bin);
    if (typeof pkg.bin === 'object' && pkg.bin !== null) {
      candidates.push(...Object.values(pkg.bin as Record<string, unknown>).filter((v): v is string => typeof v === 'string'));
    }
  } catch { /* no package.json or parse error */ }
  for (const f of ['src/index.ts', 'src/main.ts', 'src/cli.ts', 'app.ts']) {
    candidates.push(f);
  }
  return [...new Set(candidates)].filter(f => {
    try { return fs.existsSync(path.join(repoPath, f)); } catch { return false; }
  });
}

function classifyLayers(repoPath: string): BrownfieldLayer[] {
  const layers: BrownfieldLayer[] = [];

  const testPaths = ['test', 'tests', '__tests__'].filter(d => {
    try { return fs.existsSync(path.join(repoPath, d)); } catch { return false; }
  }).map(d => d + '/');
  if (testPaths.length > 0) layers.push({ name: 'test', paths: testPaths });

  const configDirs = ['configs'].filter(d => {
    try { return fs.existsSync(path.join(repoPath, d)); } catch { return false; }
  }).map(d => d + '/');
  const configFiles: string[] = [];
  try {
    for (const e of fs.readdirSync(repoPath)) {
      const full = path.join(repoPath, e);
      try {
        if (fs.statSync(full).isDirectory()) continue;
      } catch { continue; }
      if (e.startsWith('.env') || e.endsWith('.yaml') || e.endsWith('.yml') || /\.config\./.test(e)) {
        configFiles.push(e);
      }
    }
  } catch { /* ignore */ }
  const configPaths = [...configDirs, ...configFiles];
  if (configPaths.length > 0) layers.push({ name: 'config', paths: configPaths });

  const apiDirs = ['routes', 'api', 'controllers', 'handlers'].filter(d => {
    try { return fs.existsSync(path.join(repoPath, 'src', d)); } catch { return false; }
  }).map(d => `src/${d}/`);
  if (apiDirs.length > 0) layers.push({ name: 'api', paths: apiDirs });

  const domainDirs = ['domain', 'services', 'models', 'core'].filter(d => {
    try { return fs.existsSync(path.join(repoPath, 'src', d)); } catch { return false; }
  }).map(d => `src/${d}/`);
  if (domainDirs.length > 0) layers.push({ name: 'domain', paths: domainDirs });

  const infraDirs = ['db', 'cache', 'queue', 'storage'].filter(d => {
    try { return fs.existsSync(path.join(repoPath, 'src', d)); } catch { return false; }
  }).map(d => `src/${d}/`);
  if (infraDirs.length > 0) layers.push({ name: 'infra', paths: infraDirs });

  const hasSrc = (() => { try { return fs.existsSync(path.join(repoPath, 'src')); } catch { return false; } })();
  if (hasSrc) layers.push({ name: 'root', paths: ['src/'] });

  return layers;
}

function buildArchitectureMd(entry_points: string[], layers: BrownfieldLayer[]): string {
  const lines: string[] = ['# As-Is Architecture', '', '## Entry Points'];
  if (entry_points.length > 0) {
    lines.push(...entry_points.map(e => `- ${e}`));
  } else {
    lines.push('_No entry points detected_');
  }
  lines.push('', '## Layers');
  for (const layer of layers) {
    lines.push(`### ${layer.name}`);
    lines.push(...layer.paths.map(p => `- ${p}`));
    lines.push('');
  }
  return lines.join('\n');
}

function buildConventionsMd(conventions: Record<string, unknown>): string {
  const lines: string[] = ['# As-Is Conventions', ''];
  for (const [k, v] of Object.entries(conventions)) {
    lines.push(`- **${k}**: ${v}`);
  }
  return lines.join('\n');
}

export async function importBrownfieldRepo(opts: BrownfieldImportOptions): Promise<BrownfieldIntake> {
  const resolvedRepo = path.resolve(opts.repoPath);
  const resolvedOutput = path.resolve(opts.outputPath);

  if (resolvedOutput === resolvedRepo || resolvedOutput.startsWith(resolvedRepo + path.sep)) {
    throw new Error('brownfield_import_error: output must not be inside source repo');
  }

  const profile = opts.extractProfile
    ? opts.extractProfile(opts.repoPath)
    : extractProjectProfile(opts.repoPath);

  const entry_points = discoverEntryPoints(opts.repoPath);
  const layers = classifyLayers(opts.repoPath);

  const client = opts.codegraphClient ?? NULL_CLIENT;
  const impactResult = await computeImpactSet([opts.repoPath], client);
  const dependency_map: Record<string, string[]> = {};
  for (const f of impactResult.impactedFiles) {
    dependency_map[f] = [];
  }

  const conventions: Record<string, unknown> = {
    framework: profile.test_layout.framework,
    language: profile.toolchain.language,
    lint: profile.toolchain.lint_tool,
  };

  const asisDir = path.join(opts.outputPath, 'as-is');
  fs.mkdirSync(asisDir, { recursive: true });
  fs.writeFileSync(path.join(asisDir, 'ARCHITECTURE.md'), buildArchitectureMd(entry_points, layers), 'utf8');
  fs.writeFileSync(path.join(asisDir, 'CONVENTIONS.md'), buildConventionsMd(conventions), 'utf8');

  return {
    intake_id: `bf-${Date.now().toString(36)}`,
    repo_path: opts.repoPath,
    intake_at: new Date().toISOString(),
    entry_points,
    layers,
    dependency_map,
    conventions,
    recovery_docs_path: path.join(opts.outputPath, 'as-is'),
  };
}

// ── STORY-023.3: Scope-change takeover — BacklogDelta and processScopeChange ──

export interface BacklogDelta {
  new_stories: StoryNode[];
  epic_list_additions: string[];
  source_message: string;
  validated: boolean;
  validation_errors: string[];
}

export interface ScopeChangeOptions {
  runningStoryId?: string;
  ambiguityRunner?: (questions: AmbiguityQuestion[]) => Promise<Record<string, string>>;
}

function deriveStoryIdFromMessage(text: string): string {
  const slug = text.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `STORY-SC-${slug || 'unnamed'}`;
}

function validateStoryNodes(stories: StoryNode[]): string[] {
  const errors: string[] = [];
  for (const s of stories) {
    if (!s.story_id) errors.push('story_id is required');
    if (!s.allowed_write_set || s.allowed_write_set.length === 0) {
      errors.push(`allowed_write_set must be non-empty for story ${s.story_id}`);
    }
    if (!s.parallelism_class) errors.push(`parallelism_class is required for story ${s.story_id}`);
  }
  return errors;
}

export async function processScopeChange(
  messageText: string,
  opts: ScopeChangeOptions,
): Promise<BacklogDelta> {
  // Step 1: injection check
  const injectionResult = detectPromptInjection(messageText);
  if (injectionResult.detected) {
    return {
      new_stories: [],
      epic_list_additions: [],
      source_message: messageText,
      validated: false,
      validation_errors: [`scope_change_rejected: prompt injection detected: ${injectionResult.signals.join(', ')}`],
    };
  }

  // Step 2: classify the idea
  let mode: IdeaMode;
  try {
    mode = classifyIdea({ title: 'scope change', description: messageText });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { new_stories: [], epic_list_additions: [], source_message: messageText, validated: false, validation_errors: [msg] };
  }

  // Step 3: build a stub StoryNode (1 per idea)
  const storyId = deriveStoryIdFromMessage(messageText);
  const epicId = `EPIC-SC-${mode}`;
  const taskClass: TaskClass = mode === 'patch' ? 'patch' : mode === 'brownfield' ? 'brownfield' : 'greenfield';
  const storyNode: StoryNode = {
    story_id: storyId,
    depends_on: [],
    allowed_write_set: ['src/**'],
    parallelism_class: 'sequential',
    task_class: taskClass,
  };

  // Ambiguity detection (brownfield only — greenfield returns [])
  emitAmbiguityQuestions(storyNode, []);

  // Step 4: bundle gate — validate story nodes
  const validation_errors = validateStoryNodes([storyNode]);
  if (validation_errors.length > 0) {
    return { new_stories: [], epic_list_additions: [], source_message: messageText, validated: false, validation_errors };
  }

  // Step 5: preemption guard — no new story may replace the running story
  if (opts.runningStoryId && storyNode.story_id === opts.runningStoryId) {
    return {
      new_stories: [],
      epic_list_additions: [],
      source_message: messageText,
      validated: false,
      validation_errors: [`scope_change_rejected: story_id '${storyNode.story_id}' would preempt running story`],
    };
  }

  return {
    new_stories: [storyNode],
    epic_list_additions: [epicId],
    source_message: messageText,
    validated: true,
    validation_errors: [],
  };
}

// ── STORY-026.1: Frontend showcase stage flag ────────────────────────────────

export type FrontendStageDecision = 'yes' | 'no' | 'not_applicable';

export interface FrontendStageAnswer {
  decision: FrontendStageDecision;
  has_frontend_stage: boolean | null;
  showcase_story?: StoryNode | null;
  decline_recorded: boolean;
}

const WEB_SURFACE_RE = /\b(web|ui|frontend|browser)\b/i;

let _showcaseCounter = 0;
function nextShowcaseId(): string {
  _showcaseCounter += 1;
  return `STORY-SHOWCASE-${String(_showcaseCounter).padStart(4, '0')}`;
}

export function askFrontendStageQuestion(
  idea: { title: string; description: string; mode?: string },
  decision: FrontendStageDecision,
): FrontendStageAnswer {
  const isBrownfield = idea.mode === 'brownfield';
  const hasWebSurface = WEB_SURFACE_RE.test(idea.description);

  if (isBrownfield && !hasWebSurface) {
    return { decision, has_frontend_stage: null, decline_recorded: false };
  }

  if (decision === 'yes') {
    const showcaseStory: StoryNode = {
      story_id: nextShowcaseId(),
      depends_on: [],
      allowed_write_set: ['dist/**'],
      parallelism_class: 'sequential',
      task_class: 'greenfield',
    };
    return { decision, has_frontend_stage: true, showcase_story: showcaseStory, decline_recorded: false };
  }

  if (decision === 'no') {
    return { decision, has_frontend_stage: false, showcase_story: null, decline_recorded: true };
  }

  return { decision, has_frontend_stage: null, decline_recorded: false };
}

const REQUIRED_INTAKE_FIELDS = [
  'intake_id', 'repo_path', 'intake_at', 'entry_points',
  'layers', 'dependency_map', 'conventions', 'recovery_docs_path',
] as const;

export function validateBrownfieldIntake(intake: unknown): ValidationResult {
  if (typeof intake !== 'object' || intake === null) {
    return { ok: false, errors: ['brownfield intake must be a non-null object'] };
  }
  const r = intake as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_INTAKE_FIELDS) {
    if (!(field in r) || r[field] === undefined || r[field] === null) {
      errors.push(`missing required field: ${field}`);
    }
  }

  for (const field of ['intake_id', 'repo_path', 'intake_at', 'recovery_docs_path'] as const) {
    if (field in r && typeof r[field] === 'string' && !(r[field] as string).trim()) {
      errors.push(`field ${field} must be non-empty`);
    }
  }

  if (
    typeof r.recovery_docs_path === 'string' &&
    typeof r.repo_path === 'string' &&
    (r.recovery_docs_path as string).trim() &&
    r.recovery_docs_path === r.repo_path
  ) {
    errors.push('recovery_docs_path must differ from repo_path');
  }

  return { ok: errors.length === 0, errors };
}
