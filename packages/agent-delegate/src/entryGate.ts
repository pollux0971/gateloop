/**
 * @gateloop/agent-delegate — Entry gate (STORY-033.4)
 *
 * The entry of the (B) model: translate a task packet into the sandbox scope (which
 * files the read-only copy exposes + the network allowlist) and attach a cost cap +
 * a wall-clock timeout. A self-executing CLI agent must never exceed budget or run
 * unbounded — the gate is the OUTER, authoritative limit. (Claude's native
 * `--max-budget-usd` is wired as a defense-in-depth INNER cap, never a replacement.)
 *
 * Driver-agnostic: works the same for HeadlessDriver and the future AcpDriver.
 * Design: docs/architecture/17_EXTERNAL_AGENT_DELEGATION.md
 * CI-safe: no container, no network, no real process.
 */

import { buildHeadlessCommand } from './headlessDriver';
import type {
  AgentEvent,
  CliKind,
  DelegationTaskPacket,
  ExternalAgentDriver,
  SandboxHandle,
} from './seam-types';
import {
  createDelegationSandbox,
  sandboxHandle,
  type DelegationSandbox,
  type NetworkPolicy,
} from './delegationSandbox';

// ── Limits + scope ───────────────────────────────────────────────────────────────

export interface DelegationLimits {
  /** Hard cost cap (USD) for the whole delegation. */
  max_cost_usd: number;
  /** Wall-clock kill after this many milliseconds. */
  wall_clock_ms: number;
  /** Optional token ceiling (output tokens). */
  max_output_tokens?: number;
}

export interface DelegationScope {
  /** Files the agent may change (ENFORCED at the exit gate; here it shapes the packet). */
  allowed_write_set: string[];
  /** The default-deny + registry-allowlist network policy from the sandbox. */
  network: NetworkPolicy;
  /** The sandbox working dir. */
  cwd: string;
}

export interface ComposedDelegation {
  cli: CliKind;
  packet: DelegationTaskPacket;
  sandbox: DelegationSandbox;
  handle: SandboxHandle;
  scope: DelegationScope;
  limits: DelegationLimits;
  /** True when a native inner cost cap was wired into the CLI invocation. */
  native_inner_cap: boolean;
}

export interface ComposeDelegationInput {
  cli: CliKind;
  packet: DelegationTaskPacket;
  source_dir: string;
  auth_env?: Record<string, string>;
  limits: DelegationLimits;
  sandbox_mode?: SandboxHandle['sandbox_mode'];
}

function validateLimits(limits: DelegationLimits): void {
  if (!(limits.max_cost_usd > 0)) throw new Error('entry gate: max_cost_usd must be > 0');
  if (!(limits.wall_clock_ms > 0)) throw new Error('entry gate: wall_clock_ms must be > 0');
}

/**
 * Compose a delegation: build the hardened sandbox, derive the scope from the packet,
 * attach the cost cap + wall-clock timeout, and (for Claude) wire the native inner
 * cost cap. PURE w.r.t. the network/container — only a disposable temp dir is created.
 */
export function composeDelegation(input: ComposeDelegationInput): ComposedDelegation {
  validateLimits(input.limits);

  const sandbox = createDelegationSandbox({
    delegation_id: cliShort(input.cli),
    source_dir: input.source_dir,
    auth_env: input.auth_env,
    sandbox_mode: input.sandbox_mode,
  });
  const handle = sandboxHandle(sandbox, {
    delegation_id: cliShort(input.cli),
    source_dir: input.source_dir,
    auth_env: input.auth_env,
    sandbox_mode: input.sandbox_mode,
  });

  // Adoption (b): Claude exposes a native --max-budget-usd. Wire it as a defense-in-depth
  // INNER cap equal to the gate cap, only if the caller didn't already set one. The
  // entry-gate ledger + wall clock remain the OUTER, authoritative limit.
  let packet = input.packet;
  let native_inner_cap = false;
  if (input.cli === 'claude' && typeof packet.max_budget_usd !== 'number') {
    packet = { ...packet, max_budget_usd: input.limits.max_cost_usd };
    native_inner_cap = true;
  }

  const scope: DelegationScope = {
    allowed_write_set: [...input.packet.allowed_write_set],
    network: sandbox.network,
    cwd: sandbox.root,
  };

  return { cli: input.cli, packet, sandbox, handle, scope, limits: input.limits, native_inner_cap };
}

function cliShort(cli: CliKind): string {
  return cli;
}

/** Sanity check that the composed invocation is non-interactive (defense in depth). */
export function assertNonInteractive(c: ComposedDelegation): void {
  const cmd = buildHeadlessCommand(c.cli, c.packet, c.handle);
  if (!cmd.noninteractive) throw new Error('entry gate: refusing an interactive invocation');
}

// ── Budget ledger ────────────────────────────────────────────────────────────────

/**
 * Accumulates cost/tokens against the cap. The exit gate / cost bar reads `spent_usd`.
 * `costEstimator` converts token usage to USD (injected so this package needs no
 * pricing table); default = 0 cost (tokens still tracked).
 */
export class BudgetLedger {
  spent_usd = 0;
  output_tokens = 0;
  private readonly costFor: (tokens: { input: number; output: number }) => number;

  constructor(
    private readonly limits: DelegationLimits,
    costEstimator?: (tokens: { input: number; output: number }) => number,
  ) {
    this.costFor = costEstimator ?? (() => 0);
  }

  charge(tokens: { input: number; output: number }): void {
    this.spent_usd += this.costFor(tokens);
    this.output_tokens += tokens.output;
  }

  exceeded(): boolean {
    if (this.spent_usd > this.limits.max_cost_usd) return true;
    if (typeof this.limits.max_output_tokens === 'number' && this.output_tokens > this.limits.max_output_tokens) return true;
    return false;
  }

  remaining_usd(): number {
    return Math.max(0, this.limits.max_cost_usd - this.spent_usd);
  }
}

// ── Guarded run: wall-clock + budget kill ────────────────────────────────────────

export type KillReason = 'wall_clock' | 'budget';

export interface GuardedRunResult {
  events: AgentEvent[];
  killed: boolean;
  kill_reason?: KillReason;
  spent_usd: number;
  output_tokens: number;
  /** Wall-clock duration, milliseconds (from the injected clock). */
  elapsed_ms: number;
}

export interface GuardedRunOptions {
  /** Token→USD estimator; without it cost is 0 (tokens still tracked). */
  costEstimator?: (tokens: { input: number; output: number }) => number;
  /** Injectable clock for deterministic tests (defaults to Date.now). */
  now?: () => number;
  /** Injectable abort controller (defaults to a fresh AbortController). */
  controller?: AbortController;
}

/**
 * Drive a delegation under the entry-gate limits. Streams events; the moment the
 * wall clock or the budget is exceeded it ABORTS the run (signal → child kill) and
 * appends a synthetic killed completion. Always returns a terminal outcome — an
 * unbounded agent cannot run forever.
 */
export async function runDelegationGuarded(
  driver: ExternalAgentDriver,
  composed: ComposedDelegation,
  opts: GuardedRunOptions = {},
): Promise<GuardedRunResult> {
  const now = opts.now ?? Date.now;
  const controller = opts.controller ?? new AbortController();
  const ledger = new BudgetLedger(composed.limits, opts.costEstimator);
  const deadline = now() + composed.limits.wall_clock_ms;
  const start = now();

  // Wire the abort signal into the handle so the driver/spawner can kill the child.
  const handle: SandboxHandle = { ...composed.handle, signal: controller.signal };

  const events: AgentEvent[] = [];
  let killed = false;
  let kill_reason: KillReason | undefined;

  const stream = driver.run(composed.packet, handle);
  const it = stream[Symbol.asyncIterator]();

  try {
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        killed = true;
        kill_reason = 'wall_clock';
        break;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remaining);
      });
      const advance = it.next().then((r) => ({ timedOut: false as const, r }));

      const winner = await Promise.race([advance, timeout]);
      if (timer) clearTimeout(timer);

      if ('timedOut' in winner && winner.timedOut) {
        killed = true;
        kill_reason = 'wall_clock';
        break;
      }

      const { r } = winner as { timedOut: false; r: IteratorResult<AgentEvent> };
      if (r.done) break;

      const ev = r.value;
      events.push(ev);
      if (ev.tokens) ledger.charge(ev.tokens);
      if (ledger.exceeded()) {
        killed = true;
        kill_reason = 'budget';
        break;
      }
    }
  } finally {
    if (killed) {
      controller.abort();
      // Best-effort: let the underlying generator clean up.
      void it.return?.(undefined);
    }
  }

  if (killed) {
    events.push({
      cli: composed.cli,
      kind: 'completion',
      summary: `killed: ${kill_reason}`,
      stop_reason: 'cancelled',
      tokens: { input: 0, output: 0 },
      raw: { killed: true, kill_reason },
    });
  }

  return {
    events,
    killed,
    kill_reason,
    spent_usd: ledger.spent_usd,
    output_tokens: ledger.output_tokens,
    elapsed_ms: now() - start,
  };
}
