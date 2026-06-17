/**
 * @gateloop/agent-delegate — Delegation result contract (STORY-033.5)
 *
 * The bridge between a driver and the exit gate. One shape (`DelegationResult`) the
 * exit gate (033.6) consumes regardless of CLI/driver. The principle made concrete:
 *
 *   • `diff` (git diff vs the PRE-delegation tree) is AUTHORITATIVE — it is gated.
 *   • `claimed_changes` + `agent_self_report` are ADVISORY — diagnosis only, never gated.
 *   • Lie-detection: claimed_changes ≠ the diff's file set ⇒ a WARNING, not a failure.
 *
 * Self-report acquisition (adoption (a) from the SPIKE):
 *   • Claude (`--json-schema`) and Codex (`--output-schema`) provide NATIVE schema-
 *     constrained output ⇒ source = 'native_schema'.
 *   • Gemini has no native schema ⇒ prompt + VALIDATE-ON-RECEIPT; non-conforming is
 *     dropped/flagged ('dropped_nonconforming'), never trusted.
 * Either way the self-report is advisory; a missing/malformed one never blocks the gate.
 *
 * Schema: specs/delegation_result.schema.json
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 */

import type { AgentEvent, CliKind, StopReason } from './headlessDriver';

// ── The result shape ─────────────────────────────────────────────────────────────

export type SelfReportSource = 'native_schema' | 'validated_on_receipt' | 'dropped_nonconforming' | 'none';

export interface DelegationResult {
  cli: CliKind;
  driver: 'headless' | 'acp';
  /** AUTHORITATIVE — git diff vs the pre-delegation tree. The only thing gated. */
  diff: string;
  stop_reason: StopReason;
  tokens: { input: number; output: number };
  killed?: boolean;
  kill_reason?: 'wall_clock' | 'budget';
  /** ADVISORY self-report (paths the agent claims it changed). Never gated. */
  claimed_changes?: string[];
  /** ADVISORY structured self-eval. Never gated. */
  agent_self_report?: Record<string, unknown>;
  self_report_source: SelfReportSource;
  /** Non-fatal signals (incl. lie-detection). Never a gate failure. */
  warnings: string[];
}

// ── Native-schema policy (adoption (a)) ──────────────────────────────────────────

/** Which CLIs guarantee OUR schema natively. Claude (--json-schema) + Codex (--output-schema). */
export function cliUsesNativeSchema(cli: CliKind): boolean {
  return cli === 'claude' || cli === 'codex';
}

// ── Diff parsing (authoritative file set) ────────────────────────────────────────

/**
 * Parse the set of changed file paths from a unified git diff. This is the
 * AUTHORITATIVE change set; the exit gate enforces THIS against the write-set.
 * Handles `diff --git a/x b/x`, `+++ b/x`, and rename headers.
 */
export function diffFileSet(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    let m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { files.add(m[2]); continue; }
    m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') { files.add(m[1]); continue; }
    m = /^rename to (.+)$/.exec(line);
    if (m) { files.add(m[1]); continue; }
  }
  return [...files].sort();
}

// ── Self-report acquisition + validation ─────────────────────────────────────────

export interface AcquiredSelfReport {
  source: SelfReportSource;
  report?: Record<string, unknown>;
  claimed_changes?: string[];
  warnings: string[];
}

/**
 * A self-report is well-formed if it is an object and (when present) `claimed_changes`
 * is an array of strings. Schema is intentionally minimal — the self-report is advisory.
 */
function isWellFormedSelfReport(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const cc = (raw as Record<string, unknown>)['claimed_changes'];
  if (cc !== undefined && !(Array.isArray(cc) && cc.every((x) => typeof x === 'string'))) return false;
  return true;
}

/**
 * Acquire the self-report per the CLI's capability:
 *  - native-schema CLIs (Claude/Codex): trust the shape ('native_schema'); still
 *    sanity-check structure (a buggy CLI is flagged, not trusted blindly).
 *  - others (Gemini): VALIDATE-ON-RECEIPT; non-conforming ⇒ 'dropped_nonconforming'.
 *  - absent ⇒ 'none'.
 * Never throws: a bad self-report degrades to advisory-dropped, the gate is unaffected.
 */
export function acquireSelfReport(cli: CliKind, raw: unknown): AcquiredSelfReport {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) {
    return { source: 'none', warnings };
  }
  const wellFormed = isWellFormedSelfReport(raw);
  if (!wellFormed) {
    warnings.push(`self-report from ${cli} is non-conforming — dropped (advisory only; gate unaffected)`);
    return { source: 'dropped_nonconforming', warnings };
  }
  const report = raw as Record<string, unknown>;
  const claimed = Array.isArray(report['claimed_changes'])
    ? (report['claimed_changes'] as string[])
    : undefined;
  const source: SelfReportSource = cliUsesNativeSchema(cli) ? 'native_schema' : 'validated_on_receipt';
  return { source, report, claimed_changes: claimed, warnings };
}

// ── Lie-detection ────────────────────────────────────────────────────────────────

export interface LieDetectionResult {
  mismatch: boolean;
  /** Files the agent claimed but did NOT actually change. */
  over_claimed: string[];
  /** Files actually changed but NOT claimed (under-reported). */
  under_reported: string[];
  warnings: string[];
}

/**
 * Compare the advisory `claimed_changes` against the AUTHORITATIVE diff file set.
 * A mismatch is recorded as a WARNING (honesty signal) — NEVER a gate failure, since
 * the diff is what gets gated. If there is no claim, there is nothing to check.
 */
export function detectClaimMismatch(diff: string, claimed_changes?: string[]): LieDetectionResult {
  const warnings: string[] = [];
  if (!claimed_changes) {
    return { mismatch: false, over_claimed: [], under_reported: [], warnings };
  }
  const actual = new Set(diffFileSet(diff));
  const claimed = new Set(claimed_changes);
  const over_claimed = [...claimed].filter((f) => !actual.has(f)).sort();
  const under_reported = [...actual].filter((f) => !claimed.has(f)).sort();
  const mismatch = over_claimed.length > 0 || under_reported.length > 0;
  if (over_claimed.length) {
    warnings.push(`agent over-claimed changes (claimed but not in diff): ${over_claimed.join(', ')}`);
  }
  if (under_reported.length) {
    warnings.push(`agent under-reported changes (in diff but not claimed): ${under_reported.join(', ')}`);
  }
  return { mismatch, over_claimed, under_reported, warnings };
}

// ── Build the unified result (the per-CLI adapter entry point) ───────────────────

export interface BuildDelegationResultInput {
  cli: CliKind;
  driver?: 'headless' | 'acp';
  /** AUTHORITATIVE diff vs the pre-delegation tree. */
  diff: string;
  /** The driver's AgentEvent stream (for tokens + stop_reason fallback). */
  events?: AgentEvent[];
  /** Raw self-report payload as received from the CLI (advisory). */
  self_report_raw?: unknown;
  killed?: boolean;
  kill_reason?: 'wall_clock' | 'budget';
  /** Override stop_reason/tokens (e.g. from the guarded run) instead of deriving. */
  stop_reason?: StopReason;
  tokens?: { input: number; output: number };
}

/**
 * Map one CLI's output into the unified DelegationResult. Per-CLI behavior is the
 * native-vs-validated self-report policy; the diff is always authoritative and the
 * lie-detection warning is always computed. This is the adapter every CLI shares.
 */
export function buildDelegationResult(input: BuildDelegationResultInput): DelegationResult {
  const events = input.events ?? [];
  const completion = [...events].reverse().find((e) => e.kind === 'completion');

  const stop_reason: StopReason = input.stop_reason ?? completion?.stop_reason ?? 'unknown';
  const tokens = input.tokens ?? completion?.tokens ?? { input: 0, output: 0 };

  const acquired = acquireSelfReport(input.cli, input.self_report_raw);
  const lie = detectClaimMismatch(input.diff, acquired.claimed_changes);

  return {
    cli: input.cli,
    driver: input.driver ?? 'headless',
    diff: input.diff,                 // AUTHORITATIVE
    stop_reason,
    tokens,
    killed: input.killed,
    kill_reason: input.kill_reason,
    claimed_changes: acquired.claimed_changes,
    agent_self_report: acquired.report,
    self_report_source: acquired.source,
    warnings: [...acquired.warnings, ...lie.warnings],
  };
}

// ── Validation (structural — the gate-side guard) ────────────────────────────────

export interface DelegationResultValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Structural validation of a DelegationResult. Only the AUTHORITATIVE fields are
 * required (diff/stop_reason/tokens/...); the advisory self-report is optional and a
 * missing/dropped one is NOT an error — the gate must still run on the diff.
 */
export function validateDelegationResult(r: unknown): DelegationResultValidation {
  const errors: string[] = [];
  if (!r || typeof r !== 'object') return { ok: false, errors: ['result is not an object'] };
  const o = r as Record<string, unknown>;
  if (o['cli'] !== 'claude' && o['cli'] !== 'codex' && o['cli'] !== 'gemini') errors.push('cli invalid');
  if (o['driver'] !== 'headless' && o['driver'] !== 'acp') errors.push('driver invalid');
  if (typeof o['diff'] !== 'string') errors.push('diff missing (authoritative field required)');
  if (!['end_turn', 'cancelled', 'error', 'unknown'].includes(o['stop_reason'] as string)) errors.push('stop_reason invalid');
  const tokens = o['tokens'] as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens['input'] !== 'number' || typeof tokens['output'] !== 'number') errors.push('tokens invalid');
  if (!['native_schema', 'validated_on_receipt', 'dropped_nonconforming', 'none'].includes(o['self_report_source'] as string)) errors.push('self_report_source invalid');
  if (!Array.isArray(o['warnings'])) errors.push('warnings must be an array');
  return { ok: errors.length === 0, errors };
}
