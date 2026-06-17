/**
 * @gateloop/preflight-runner
 *
 * Developer's ADVISORY self-check before submitting a proposal: apply in a disposable
 * workspace → typecheck → affected tests → self-correct (bounded) → submit. The
 * Validator alone gives the real verdict; preflight only reduces low-level errors and
 * bounds self-correction (repeated signature ⇒ escalate, never loop). Schema:
 * specs/preflight_report.schema.json.
 */
export interface PreflightPolicy { maxSelfCorrectionAttempts: number; allowedCommands: string[]; forbidden: string[] }
export const DEFAULT_PREFLIGHT_POLICY: PreflightPolicy = {
  maxSelfCorrectionAttempts: 2,
  allowedCommands: ['pnpm typecheck', 'pnpm test --filter affected', 'pnpm test'],
  forbidden: ['full repo mutation outside write-set', 'deleting tests', 'changing policy to pass tests', 'marking failed preflight as passed'],
};
export interface PreflightReport {
  advisory: true; passed: boolean; commands_run: string[]; failures: string[];
  self_correction_attempts: number; last_failure_signature?: string;
  verdict: PreflightDecision; story_id?: string;
}
export type PreflightDecision = 'submit' | 'self_correct' | 'escalate';

/** Pure: decide the next preflight action. Bounds self-correction; repeated signature ⇒ escalate. */
export function decidePreflightNext(o: {
  passed: boolean; attempts: number; sameSignatureCount: number;
  policy?: PreflightPolicy; sameSignatureLimit?: number;
}): PreflightDecision {
  const max = (o.policy ?? DEFAULT_PREFLIGHT_POLICY).maxSelfCorrectionAttempts;
  const sigLimit = o.sameSignatureLimit ?? 2;
  if (o.passed) return 'submit';
  if (o.sameSignatureCount >= sigLimit) return 'escalate';
  if (o.attempts >= max) return 'escalate';
  return 'self_correct';
}

/** A preflight command is allowed only if it is on the allow-list (prefix) and not forbidden. */
export function isCommandAllowed(cmd: string, policy: PreflightPolicy = DEFAULT_PREFLIGHT_POLICY): boolean {
  const c = cmd.trim().toLowerCase();
  if (/rm\s+-rf|sudo|delete.*test|>\s*policy|chmod|curl|wget/.test(c)) return false;
  return policy.allowedCommands.some(a => c.startsWith(a.toLowerCase().split(' ')[0]) && c.startsWith(a.toLowerCase().slice(0, 8)));
}

/**
 * Advisory self-check: validate that requested commands are allowed, simulate their
 * outcomes from proposal.validation_results (no real shell), and decide the next action.
 *
 * Proposal fields (all optional):
 *   story_id                — propagated into the report
 *   commands                — commands to check; defaults to first two policy.allowedCommands
 *   validation_results      — map of cmd→boolean; undefined entry ⇒ optimistic pass
 *   self_correction_attempts — how many attempts have been made so far (default 0)
 *   same_signature_count    — repeated-signature counter (default 0)
 *
 * Returns a PreflightReport. advisory:true signals this is NEVER the story verdict.
 */
export async function runPreflight(
  proposal: Record<string, unknown>,
  _workspace: unknown,
  policy: PreflightPolicy = DEFAULT_PREFLIGHT_POLICY,
): Promise<PreflightReport> {
  const storyId = typeof proposal.story_id === 'string' ? proposal.story_id : undefined;
  const selfCorrectionAttempts = typeof proposal.self_correction_attempts === 'number'
    ? proposal.self_correction_attempts : 0;
  const sameSignatureCount = typeof proposal.same_signature_count === 'number'
    ? proposal.same_signature_count : 0;

  // Default to typecheck + affected-tests when caller supplies no command list.
  const requestedCommands: string[] = Array.isArray(proposal.commands)
    ? (proposal.commands as string[])
    : [policy.allowedCommands[0], policy.allowedCommands[1]].filter(Boolean);

  // Blocked commands ⇒ immediate escalate; forbidden commands must not run.
  const blockedCommands = requestedCommands.filter(cmd => !isCommandAllowed(cmd, policy));
  if (blockedCommands.length > 0) {
    const sig = `blocked:${blockedCommands.join(',')}`;
    return {
      advisory: true,
      passed: false,
      commands_run: [],
      failures: blockedCommands.map(c => `blocked: ${c}`),
      self_correction_attempts: selfCorrectionAttempts,
      last_failure_signature: sig,
      verdict: 'escalate',
      ...(storyId !== undefined ? { story_id: storyId } : {}),
    };
  }

  // Advisory "run": consult proposal.validation_results to determine pass/fail per command.
  // If not provided, commands are assumed to pass (optimistic — real results come from the workspace).
  const validationResults: Record<string, boolean> =
    typeof proposal.validation_results === 'object' && proposal.validation_results !== null
      ? (proposal.validation_results as Record<string, boolean>)
      : {};

  const commandsRun: string[] = [];
  const failures: string[] = [];
  for (const cmd of requestedCommands) {
    commandsRun.push(cmd);
    if (validationResults[cmd] === false) failures.push(cmd);
  }

  const passed = failures.length === 0;
  const currentSig = failures.length > 0 ? failures.join(';') : undefined;

  const verdict = decidePreflightNext({
    passed,
    attempts: selfCorrectionAttempts,
    sameSignatureCount,
    policy,
  });

  return {
    advisory: true,
    passed,
    commands_run: commandsRun,
    failures,
    self_correction_attempts: selfCorrectionAttempts,
    verdict,
    ...(currentSig !== undefined ? { last_failure_signature: currentSig } : {}),
    ...(storyId !== undefined ? { story_id: storyId } : {}),
  };
}

// ── REAL execution layer (de-stub) ───────────────────────────────────────────
// `runPreflight` above is the PURE decision core: given results, it decides
// submit/self_correct/escalate. It does NOT observe anything — it reads a
// caller-supplied validation_results map. That is the stub the Developer's
// Observe step must not use.
//
// `executePreflight` below is the real Observe: it APPLIES the proposed edits to
// a disposable workspace, RUNS typecheck + the affected tests for real, builds the
// validation_results from those REAL outcomes, and then delegates the decision to
// the same pure core. This is what catches an in-file behaviour deletion that the
// additive gate (which only flags operation==='delete') lets through: a `modify`
// that strips existing lines makes the affected tests go RED, and the real run sees it.
//
// The shell work is INJECTED (apply/typecheck/test runners) so it is deterministic
// and CI-safe — fixtures inject a real but tiny `node --test` run over a seeded
// workspace (genuine observation, no model, no network), and unit tests inject
// deterministic runners. Default runners use only node builtins (no new deps).

import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

/** A single proposed edit, as the Observe layer applies it to the workspace. */
export interface PreflightEdit {
  path: string;
  /** Full file content for create/modify. A `modify` that drops lines is exactly
   *  the case the additive gate misses — the real test run is what catches it. */
  content?: string;
  operation?: 'create' | 'modify' | 'delete';
}

/** Result of a real test run inside the workspace. */
export interface PreflightTestRun {
  passed: boolean;
  output: string;
  /** Test names/files that went red — the Observe payload fed back for self-correction. */
  failing: string[];
}

/** Result of a real typecheck inside the workspace. */
export interface PreflightTypecheckRun {
  ok: boolean;
  output: string;
}

/** Injected real-shell collaborators. Overridable for deterministic unit tests. */
export interface PreflightExecDeps {
  /** Apply the proposed edits into the workspace dir (real fs). */
  applyEdits?: (wsRoot: string, edits: PreflightEdit[]) => void;
  /** Run typecheck in the workspace. Optional — omitted ⇒ typecheck is skipped (ok). */
  runTypecheck?: (wsRoot: string) => PreflightTypecheckRun;
  /** Run the affected tests in the workspace. Required — this is the Observe core. */
  runTests: (wsRoot: string, targets: string[]) => PreflightTestRun;
}

export interface PreflightExecInput {
  /** Disposable workspace root the edits are applied into (already isolated). */
  wsRoot: string;
  /** The Developer's proposed edits (from the patch proposal). */
  edits: PreflightEdit[];
  /** Affected test targets to run; empty ⇒ the runner decides (e.g. whole suite). */
  affectedTests?: string[];
  /** Self-correction attempts already made (bounds the verdict). */
  selfCorrectionAttempts?: number;
  /** Repeated-signature counter (a recurring red ⇒ escalate, never loop). */
  sameSignatureCount?: number;
  storyId?: string;
  policy?: PreflightPolicy;
}

/** A preflight report from a REAL run. `executed: true` is the proof it was not a map read. */
export interface PreflightExecReport extends PreflightReport {
  /** REAL outcome: tests that went red applying this patch (the Observe payload). */
  failing_tests: string[];
  /** REAL outcome: did typecheck pass (true when no typecheck runner was injected). */
  typecheck_ok: boolean;
  /** Marks a genuine apply-and-run — distinguishes from the pure map-reading decision. */
  executed: true;
}

/** Default real edit applier — node builtins only, no new deps. */
export function defaultApplyEdits(wsRoot: string, edits: PreflightEdit[]): void {
  for (const e of edits) {
    const abs = nodePath.join(wsRoot, e.path);
    if (e.operation === 'delete') {
      nodeFs.rmSync(abs, { force: true });
      continue;
    }
    nodeFs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    nodeFs.writeFileSync(abs, e.content ?? '');
  }
}

/** Parse `not ok <desc>` lines from a node:test/TAP run; fall back to the targets. */
function parseFailingTests(output: string, targets: string[]): string[] {
  const failing: string[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*not ok\s+\d+\s+-?\s*(.+?)\s*$/.exec(line);
    if (m && m[1] && !/^subtest/i.test(m[1])) failing.push(m[1].trim());
  }
  return failing.length > 0 ? [...new Set(failing)] : targets.slice();
}

/** Default real test runner — `node --test` over the affected files in the workspace. */
export function defaultRunTests(wsRoot: string, targets: string[]): PreflightTestRun {
  const args = ['--test', ...targets];
  const r = spawnSync(process.execPath, args, { cwd: wsRoot, encoding: 'utf8' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const passed = r.status === 0;
  return { passed, output, failing: passed ? [] : parseFailingTests(output, targets) };
}

/**
 * The Developer's REAL pre-submit Observe. Applies the proposed edits to the
 * disposable workspace, runs typecheck + the affected tests for real, and decides
 * submit/self_correct/escalate from those REAL outcomes via the pure core.
 *
 * Unlike `runPreflight`, it never reads a supplied validation_results map — it
 * COMPUTES the results by running. A `modify` that drops existing behaviour makes
 * the affected tests fail, so the report comes back `passed: false` with the red
 * tests named — the exact signal the static gates could not produce.
 */
export async function executePreflight(
  input: PreflightExecInput,
  deps: PreflightExecDeps,
): Promise<PreflightExecReport> {
  const policy = input.policy ?? DEFAULT_PREFLIGHT_POLICY;
  const apply = deps.applyEdits ?? defaultApplyEdits;
  const targets = input.affectedTests ?? [];
  const selfCorrectionAttempts = input.selfCorrectionAttempts ?? 0;
  const sameSignatureCount = input.sameSignatureCount ?? 0;

  // 1. Apply the proposed edits into the isolated workspace (real fs).
  apply(input.wsRoot, input.edits);

  // 2. Real typecheck (skipped — treated as ok — when no runner is injected).
  const tc = deps.runTypecheck ? deps.runTypecheck(input.wsRoot) : { ok: true, output: '' };

  // 3. Real affected-tests run — the Observe core.
  const tests = deps.runTests(input.wsRoot, targets);

  // 4. Build the report from REAL outcomes (not a supplied map).
  const commandsRun: string[] = [];
  if (deps.runTypecheck) commandsRun.push('pnpm typecheck');
  commandsRun.push('pnpm test --filter affected');

  const failures: string[] = [
    ...(!tc.ok ? ['typecheck'] : []),
    ...tests.failing,
  ];
  const passed = tc.ok && tests.passed;
  const currentSig = failures.length > 0 ? failures.join(';') : undefined;

  // 5. Delegate the decision to the same pure core every other caller uses.
  const verdict = decidePreflightNext({
    passed,
    attempts: selfCorrectionAttempts,
    sameSignatureCount,
    policy,
  });

  return {
    advisory: true,
    passed,
    commands_run: commandsRun,
    failures,
    self_correction_attempts: selfCorrectionAttempts,
    verdict,
    failing_tests: tests.failing,
    typecheck_ok: tc.ok,
    executed: true,
    ...(currentSig !== undefined ? { last_failure_signature: currentSig } : {}),
    ...(input.storyId !== undefined ? { story_id: input.storyId } : {}),
  };
}
