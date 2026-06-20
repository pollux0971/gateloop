/**
 * @gateloop/external-agent — Builder execution-mode abstraction (EPIC-034 / STORY-034.2).
 *
 * Two interchangeable builder modes behind ONE exit gate + ONE result contract:
 *   - agent_mode (shipped): an API model acting only through the ACI tool interface;
 *   - cli_mode (new): an external CLI agent (Claude Code) routed through EPIC-033's
 *     ExternalAgentDriver / HeadlessDriver.
 *
 * The design principle (docs/architecture/18_DUAL_MODE_BUILDER.md): a mode is just a
 * DiffProducer. Whatever produces the diff, the diff is an UNTRUSTED artifact that flows
 * through the SAME shared path — buildDelegationResult/adapt → runExitGate (033) →
 * decideDelegationOutcome (harness-core). Nothing trust-bearing is per-mode; only the
 * producer differs. Default is agent_mode (fail-safe). This story is the abstraction only:
 * cli_mode routes to 033's driver; the deepened controlled-bash bridge is 034.3; no real
 * CLI is spawned here (a real driver would only be supplied behind the 034.5 gate).
 */
import {
  type AgentEvent,
  type CliKind,
  type DelegationTaskPacket,
  type SandboxHandle,
  type ExternalAgentDriver,
  type DelegationResult,
  type ExitGateContract,
  type ExitGateGates,
  type ExitGateVerdict,
  buildDelegationResult,
  runExitGate,
} from '@gateloop/agent-delegate';
import { decideDelegationOutcome, type DelegationOutcomeDecision } from '@gateloop/harness-core';

// Controlled-bash bridge (STORY-034.3).
export * from './controlledBash';

// Sandbox isolation invariants — the 034.5 barrier (STORY-034.4).
export * from './isolation';

// OS-enforced sandbox cage (STORY-034.5).
export * from './osCage';

// ── Mode selection ───────────────────────────────────────────────────────────────

export type BuilderMode = 'agent_mode' | 'cli_mode';

/** Fail-safe default: when nothing explicitly asks for cli_mode, the builder runs as the
 *  proven agent_mode. cli_mode is the higher-capability/higher-risk path and is opt-in. */
export const DEFAULT_BUILDER_MODE: BuilderMode = 'agent_mode';

export interface BuilderModeConfig {
  /** Per-story/config selector. Only an explicit, valid 'cli_mode' switches modes. */
  mode?: BuilderMode | string;
}

/** Resolve the builder mode. Anything other than an explicit valid 'cli_mode'
 *  (undefined, garbage, 'agent_mode') resolves to agent_mode — never fail OPEN into the
 *  high-capability mode by accident. */
export function selectBuilderMode(cfg?: BuilderModeConfig): BuilderMode {
  return cfg?.mode === 'cli_mode' ? 'cli_mode' : DEFAULT_BUILDER_MODE;
}

// ── The producer abstraction (the only per-mode part) ─────────────────────────────

/** The untrusted artifact a mode yields. The diff is authoritative downstream; events
 *  and self-report are advisory (observation only — never gate input). */
export interface ProducedDiff {
  /** AUTHORITATIVE git diff vs the pre-delegation tree. */
  diff: string;
  /** The mode's AgentEvent stream (cli_mode: driver output; agent_mode: optional). */
  events: AgentEvent[];
  /** Raw self-report payload (cli_mode only; advisory). */
  self_report_raw?: unknown;
  killed?: boolean;
  kill_reason?: 'wall_clock' | 'budget';
  /** Which CLI produced the diff (cli_mode); undefined for agent_mode (not a CLI). */
  cli?: CliKind;
}

export interface DiffProducer {
  readonly mode: BuilderMode;
  produce(packet: DelegationTaskPacket, sandbox: SandboxHandle): Promise<ProducedDiff>;
}

/**
 * agent_mode producer — wraps the in-process ACI/developer diff path. Additive: it does
 * NOT change existing agent_mode behavior; it only adapts that path into the DiffProducer
 * shape so it can share the unified runner. The caller injects the function that yields
 * the diff (e.g. edits → diff from producePatchProposal).
 */
export function agentModeProducer(
  run: (packet: DelegationTaskPacket, sandbox: SandboxHandle) => Promise<ProducedDiff>,
): DiffProducer {
  return { mode: 'agent_mode', produce: run };
}

/**
 * cli_mode producer — routes to a 033 ExternalAgentDriver (HeadlessDriver), consuming its
 * AgentEvent stream and deriving the authoritative diff via the injected getDiff (which, in
 * 034.3+, reads `git diff` from the sandbox after the run). No real CLI is spawned unless a
 * real driver is supplied — tests pass a scripted/stub driver, so this is CI-safe.
 */
export function cliModeProducer(
  cli: CliKind,
  driver: ExternalAgentDriver,
  getDiff: (events: AgentEvent[]) => string | Promise<string>,
): DiffProducer {
  return {
    mode: 'cli_mode',
    async produce(packet, sandbox) {
      const events: AgentEvent[] = [];
      for await (const ev of driver.run(packet, sandbox)) events.push(ev);
      const diff = await getDiff(events);
      return { diff, events, cli };
    },
  };
}

// ── Shared result contract + exit gate (reused from 033 — NOT rebuilt) ─────────────

/**
 * Adapt a produced diff into the SHARED DelegationResult the exit gate consumes.
 * - cli_mode uses 033's buildDelegationResult (full per-CLI native-vs-validated self-report
 *   policy + lie detection).
 * - agent_mode is NOT a CLI and carries no self-report, so it is adapted directly. The exit
 *   gate consumes only the AUTHORITATIVE diff (+ advisory warnings) and EXCLUDES every
 *   self-report regardless of mode, so the (unused) cli field is left undefined rather than
 *   mislabeled as a real CLI.
 */
export function toDelegationResult(mode: BuilderMode, produced: ProducedDiff): DelegationResult {
  if (mode === 'cli_mode') {
    return buildDelegationResult({
      cli: produced.cli ?? 'claude',
      diff: produced.diff,
      events: produced.events,
      self_report_raw: produced.self_report_raw,
      killed: produced.killed,
      kill_reason: produced.kill_reason,
    });
  }
  return {
    cli: undefined as unknown as CliKind, // agent_mode is not a CLI; field unused by the gate
    driver: 'headless',
    diff: produced.diff,
    stop_reason: 'end_turn',
    tokens: { input: 0, output: 0 },
    killed: produced.killed,
    kill_reason: produced.kill_reason,
    self_report_source: 'none',
    warnings: [],
  };
}

// ── Trace ──────────────────────────────────────────────────────────────────────

export interface BuilderModeTraceEvent {
  type: 'builder_mode';
  mode: BuilderMode;
  story_id: string;
  /** Present in cli_mode (which CLI ran); absent in agent_mode. */
  cli?: CliKind;
  accepted: boolean;
  action: DelegationOutcomeDecision['action'];
}

/** The trace record proving which mode a story ran in (034.6 projects this in the cockpit). */
export function builderModeTraceEvent(
  mode: BuilderMode,
  story_id: string,
  verdict: ExitGateVerdict,
  decision: DelegationOutcomeDecision,
  cli?: CliKind,
): BuilderModeTraceEvent {
  return { type: 'builder_mode', mode, story_id, cli, accepted: verdict.accepted, action: decision.action };
}

// ── The unified runner — both modes converge here ─────────────────────────────────

export interface RunBuilderModeInput {
  mode: BuilderMode;
  producer: DiffProducer;
  packet: DelegationTaskPacket;
  sandbox: SandboxHandle;
  contract: ExitGateContract;
  gates?: ExitGateGates;
}

export interface BuilderModeRunResult {
  mode: BuilderMode;
  result: DelegationResult;
  verdict: ExitGateVerdict;
  decision: DelegationOutcomeDecision;
  trace: BuilderModeTraceEvent;
}

/**
 * Run a story in the given mode. BOTH modes converge on the SAME exit gate (runExitGate,
 * 033) and the SAME orchestration decision (decideDelegationOutcome, harness-core). The
 * producer is the only per-mode part; everything after the diff is shared and unchanged.
 */
export async function runBuilderMode(input: RunBuilderModeInput): Promise<BuilderModeRunResult> {
  if (input.producer.mode !== input.mode) {
    throw new Error(`builder mode mismatch: requested ${input.mode} but producer is ${input.producer.mode}`);
  }
  const produced = await input.producer.produce(input.packet, input.sandbox);
  const result = toDelegationResult(input.mode, produced);
  const verdict = await runExitGate(result, input.contract, input.gates ?? {});
  const decision = decideDelegationOutcome(verdict);
  const trace = builderModeTraceEvent(input.mode, input.contract.story_id, verdict, decision, produced.cli);
  return { mode: input.mode, result, verdict, decision, trace };
}
