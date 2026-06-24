/**
 * @gateloop/planning-steward — Planning Workflow config + loader
 * STORY-PFLOW.2 (EPIC-PFLOW): workflow configuration schema + deterministic loader.
 *
 * Loads `configs/planning_workflow.yaml`: an ORDERED list of planning stages,
 * each carrying { id, name, desc, skill }, plus top-level { mode, label }. The
 * loader is a pure, deterministic parser of a CONSTRAINED YAML subset — same
 * text always yields the same parsed stages (no Date, no randomness, no I/O in
 * the pure path). Malformed or missing config throws a descriptive
 * PlanningWorkflowConfigError with the offending line — never a silent default.
 *
 * Why a constrained in-package parser rather than the `yaml` dependency: this
 * story's write-set is packages/planning-steward/ + configs/ + tests/. `yaml`
 * is not a declared dependency of this package, and adding it would mutate the
 * root pnpm-lock.yaml (outside the write-set). The config schema here is small,
 * fixed, and self-authored, so a deterministic line-based loader keeps the story
 * strictly in scope while making the "errors clearly, not silently" behaviour
 * precise. No state machine here yet — that is STORY-PFLOW.3.
 *
 * Per ADR-0013 (operator-trust) this is flow/quality logic; it introduces no
 * access or security gate.
 */
import * as fs from 'node:fs';

/** One ordered planning stage. `skill` is null when the stage has no BMAD skill. */
export interface PlanningWorkflowStage {
  id: string;
  name: string;
  desc: string;
  skill: string | null;
}

/** The parsed planning workflow configuration (ordered stages + flow metadata). */
export interface PlanningWorkflowConfig {
  mode: string;
  label: string;
  stages: PlanningWorkflowStage[];
}

/** Thrown on any malformed/missing config. Never swallowed (behaviour 3). */
export class PlanningWorkflowConfigError extends Error {
  constructor(message: string) {
    super(`planning_workflow: ${message}`);
    this.name = 'PlanningWorkflowConfigError';
  }
}

const REQUIRED_STAGE_FIELDS = ['id', 'name', 'desc', 'skill'] as const;
type StageField = (typeof REQUIRED_STAGE_FIELDS)[number];

interface PhysicalLine {
  indent: number; // count of leading spaces
  content: string; // line with leading whitespace removed, trailing kept (handlers trim)
  line: number; // 1-based source line number
}

/** Strip a YAML scalar: quotes removed, `~`/`null`/empty → null. Deterministic. */
function parseScalar(raw: string): string | null {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v.length >= 2) {
    const q = v[0];
    if ((q === '"' || q === "'") && v[v.length - 1] === q) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/** Split "key: value" on the FIRST colon. Throws if no colon / empty key. */
function splitKeyValue(content: string, line: number): { key: string; value: string } {
  const idx = content.indexOf(':');
  if (idx === -1) {
    throw new PlanningWorkflowConfigError(`line ${line}: expected "key: value", got "${content.trim()}"`);
  }
  const key = content.slice(0, idx).trim();
  if (!key) throw new PlanningWorkflowConfigError(`line ${line}: empty key in "${content.trim()}"`);
  return { key, value: content.slice(idx + 1) };
}

/** Tokenise into significant lines: drop blanks + full-line comments, reject tabs. */
function tokenise(yamlText: string): PhysicalLine[] {
  const out: PhysicalLine[] = [];
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const trimmedStart = raw.trimStart();
    if (trimmedStart === '' || trimmedStart.startsWith('#')) continue; // blank / comment
    const indent = raw.length - trimmedStart.length;
    if (/^\t/.test(raw) || /^ *\t/.test(raw.slice(0, indent + 1))) {
      throw new PlanningWorkflowConfigError(`line ${i + 1}: tab indentation is not allowed; use spaces`);
    }
    out.push({ indent, content: trimmedStart, line: i + 1 });
  }
  return out;
}

/**
 * Parse a planning workflow config from YAML text (pure, deterministic).
 * @throws PlanningWorkflowConfigError on any malformation.
 */
export function parsePlanningWorkflow(yamlText: string): PlanningWorkflowConfig {
  if (typeof yamlText !== 'string') {
    throw new PlanningWorkflowConfigError('config text must be a string');
  }
  const toks = tokenise(yamlText);
  if (toks.length === 0) throw new PlanningWorkflowConfigError('config is empty');

  const top: Record<string, string | null> = {};
  let sawStagesKey = false;
  let dashIndent = -1; // indent of the current stage's `- ` line, -1 until first stage
  const stages: Array<{ fields: Partial<Record<StageField, string | null>>; seen: Set<string>; line: number }> = [];

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];

    // ── top-level (indent 0) ──────────────────────────────────────────────
    if (t.indent === 0) {
      const { key, value } = splitKeyValue(t.content, t.line);
      if (key === 'stages') {
        if (parseScalar(value) !== null) {
          throw new PlanningWorkflowConfigError(`line ${t.line}: 'stages' must be a list (no inline value)`);
        }
        if (sawStagesKey) throw new PlanningWorkflowConfigError(`line ${t.line}: duplicate top-level key 'stages'`);
        sawStagesKey = true;
        continue;
      }
      if (key !== 'mode' && key !== 'label') {
        throw new PlanningWorkflowConfigError(`line ${t.line}: unknown top-level key '${key}' (allowed: mode, label, stages)`);
      }
      if (key in top) throw new PlanningWorkflowConfigError(`line ${t.line}: duplicate top-level key '${key}'`);
      top[key] = parseScalar(value);
      continue;
    }

    // ── stage list (indented) ─────────────────────────────────────────────
    if (!sawStagesKey) {
      throw new PlanningWorkflowConfigError(`line ${t.line}: indented content before any 'stages:' list`);
    }

    if (t.content.startsWith('- ')) {
      // new stage; the dash line carries the first field
      dashIndent = t.indent;
      const first = splitKeyValue(t.content.slice(2), t.line);
      const stage = { fields: {} as Partial<Record<StageField, string | null>>, seen: new Set<string>(), line: t.line };
      assignStageField(stage, first.key, first.value, t.line);
      stages.push(stage);
      continue;
    }

    // continuation field of the current stage (must be indented past the dash)
    if (dashIndent === -1 || t.indent <= dashIndent) {
      throw new PlanningWorkflowConfigError(`line ${t.line}: stage field "${t.content.trim()}" is not indented under a "- " stage item`);
    }
    const { key, value } = splitKeyValue(t.content, t.line);
    assignStageField(stages[stages.length - 1], key, value, t.line);
  }

  // ── validate top-level ──────────────────────────────────────────────────
  for (const k of ['mode', 'label'] as const) {
    if (!(k in top) || top[k] === null) {
      throw new PlanningWorkflowConfigError(`missing required top-level scalar '${k}'`);
    }
  }
  if (!sawStagesKey) throw new PlanningWorkflowConfigError("missing 'stages' list");
  if (stages.length === 0) throw new PlanningWorkflowConfigError("'stages' must be a non-empty ordered list");

  // ── validate + build each stage ─────────────────────────────────────────
  const ids = new Set<string>();
  const built: PlanningWorkflowStage[] = stages.map((s, idx) => {
    for (const f of REQUIRED_STAGE_FIELDS) {
      if (!s.seen.has(f)) {
        throw new PlanningWorkflowConfigError(`stage #${idx} (line ${s.line}) is missing required field '${f}'`);
      }
    }
    const id = s.fields.id;
    const name = s.fields.name;
    const desc = s.fields.desc;
    for (const [fname, fval] of [['id', id], ['name', name], ['desc', desc]] as const) {
      if (fval === null || fval === undefined || fval === '') {
        throw new PlanningWorkflowConfigError(`stage #${idx} (line ${s.line}) field '${fname}' must be a non-empty string`);
      }
    }
    if (ids.has(id as string)) {
      throw new PlanningWorkflowConfigError(`duplicate stage id '${id}' (line ${s.line})`);
    }
    ids.add(id as string);
    return { id: id as string, name: name as string, desc: desc as string, skill: s.fields.skill ?? null };
  });

  return { mode: top.mode as string, label: top.label as string, stages: built };
}

function assignStageField(
  stage: { fields: Partial<Record<StageField, string | null>>; seen: Set<string> },
  key: string,
  rawValue: string,
  line: number,
): void {
  if (!(REQUIRED_STAGE_FIELDS as readonly string[]).includes(key)) {
    throw new PlanningWorkflowConfigError(`line ${line}: unknown stage field '${key}' (allowed: ${REQUIRED_STAGE_FIELDS.join(', ')})`);
  }
  if (stage.seen.has(key)) {
    throw new PlanningWorkflowConfigError(`line ${line}: duplicate stage field '${key}'`);
  }
  stage.seen.add(key);
  stage.fields[key as StageField] = parseScalar(rawValue);
}

/**
 * Read + parse a planning workflow config file. Thin I/O wrapper over
 * {@link parsePlanningWorkflow}; a missing/unreadable file throws clearly.
 */
export function loadPlanningWorkflowFile(filePath: string): PlanningWorkflowConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new PlanningWorkflowConfigError(`cannot read config file '${filePath}': ${(e as Error).message}`);
  }
  return parsePlanningWorkflow(text);
}

// ════════════════════════════════════════════════════════════════════════════
// STORY-PFLOW.3 — Workflow state machine (per-stage status + order enforcement)
//
// Deterministic engine over the loaded stages. Tracks each stage's status
// (todo/active/done), exposes a flow-state snapshot, and ENFORCES order: exactly
// one stage is active at a time and a stage may only become active after its
// predecessor is done. Pure: every transition returns a NEW state; no Date, no
// randomness, no I/O → same inputs always yield the same state. No checklist
// gating yet (EPIC-PSKILL adds that on top via completeStage wiring). This is
// flow/quality logic, NOT an access gate (ADR-0013 operator-trust).
// ════════════════════════════════════════════════════════════════════════════

/** Per-stage status in the workflow lifecycle. */
export type StageStatus = 'todo' | 'active' | 'done';

/** A stage plus its live status — the unit of the flow-state snapshot. */
export interface FlowStageSnapshot extends PlanningWorkflowStage {
  status: StageStatus;
}

/** The live workflow state: ordered stages + a parallel status array. */
export interface PlanningFlowState {
  mode: string;
  label: string;
  stages: PlanningWorkflowStage[];
  statuses: StageStatus[]; // statuses[i] is the status of stages[i]
}

/** Thrown on an illegal state transition (e.g. activating out of order). */
export class PlanningWorkflowStateError extends Error {
  constructor(message: string) {
    super(`planning_workflow_state: ${message}`);
    this.name = 'PlanningWorkflowStateError';
  }
}

/**
 * Initialise the flow from a parsed config: the first stage is `active`, every
 * other stage is `todo`. (The config loader guarantees a non-empty stage list.)
 */
export function initFlowState(config: PlanningWorkflowConfig): PlanningFlowState {
  if (config.stages.length === 0) {
    throw new PlanningWorkflowStateError('cannot initialise flow with zero stages');
  }
  const statuses: StageStatus[] = config.stages.map((_, i) => (i === 0 ? 'active' : 'todo'));
  return {
    mode: config.mode,
    label: config.label,
    stages: config.stages.map((s) => ({ ...s })),
    statuses,
  };
}

/** The flow-state snapshot: [{ id, name, desc, skill, status }] in stage order. */
export function flowSnapshot(state: PlanningFlowState): FlowStageSnapshot[] {
  return state.stages.map((s, i) => ({ ...s, status: state.statuses[i] }));
}

/** Index of the single `active` stage, or -1 when the flow is complete. */
export function activeIndex(state: PlanningFlowState): number {
  return state.statuses.indexOf('active');
}

/** True once every stage is `done` (no active stage remains). */
export function isComplete(state: PlanningFlowState): boolean {
  return state.statuses.every((s) => s === 'done');
}

/**
 * Whether stage `i` may legally become active: it must be `todo` and every
 * preceding stage must be `done`. This is the order-enforcement predicate the
 * PFLOW.4 barrier proves bites.
 */
export function canActivate(state: PlanningFlowState, i: number): boolean {
  if (i < 0 || i >= state.stages.length) return false;
  if (state.statuses[i] !== 'todo') return false;
  return state.statuses.slice(0, i).every((s) => s === 'done');
}

/**
 * Activate stage `i`, enforcing order. THROWS (never silently no-ops) when the
 * predecessor is not yet done / the stage is not `todo` / `i` is out of range.
 * @throws PlanningWorkflowStateError
 */
export function activateStage(state: PlanningFlowState, i: number): PlanningFlowState {
  if (i < 0 || i >= state.stages.length) {
    throw new PlanningWorkflowStateError(`stage index ${i} out of range (0..${state.stages.length - 1})`);
  }
  if (state.statuses[i] === 'active') {
    throw new PlanningWorkflowStateError(`stage '${state.stages[i].id}' is already active`);
  }
  if (state.statuses[i] === 'done') {
    throw new PlanningWorkflowStateError(`stage '${state.stages[i].id}' is already done`);
  }
  const firstNotDone = state.statuses.slice(0, i).findIndex((s) => s !== 'done');
  if (firstNotDone !== -1) {
    throw new PlanningWorkflowStateError(
      `cannot activate stage '${state.stages[i].id}': predecessor '${state.stages[firstNotDone].id}' is '${state.statuses[firstNotDone]}', not 'done'`,
    );
  }
  const statuses = [...state.statuses];
  statuses[i] = 'active';
  return { ...state, stages: state.stages.map((s) => ({ ...s })), statuses };
}

/**
 * Advance the flow: mark the currently active stage `done` and activate the
 * next stage (if any). When the last stage advances, the flow becomes complete
 * (zero active). THROWS if there is no active stage (already complete).
 * @throws PlanningWorkflowStateError
 */
export function advance(state: PlanningFlowState): PlanningFlowState {
  const ai = activeIndex(state);
  if (ai === -1) {
    throw new PlanningWorkflowStateError('flow is already complete; no active stage to advance');
  }
  const statuses = [...state.statuses];
  statuses[ai] = 'done';
  if (ai + 1 < statuses.length) statuses[ai + 1] = 'active';
  return { ...state, stages: state.stages.map((s) => ({ ...s })), statuses };
}
