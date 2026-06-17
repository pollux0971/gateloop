import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  composeDelegation,
  runDelegationGuarded,
  assertNonInteractive,
  BudgetLedger,
  type ComposedDelegation,
  type DelegationLimits,
} from './entryGate';
import { destroyDelegationSandbox } from './delegationSandbox';
import {
  type AgentEvent,
  type CliKind,
  type DelegationTaskPacket,
  type ExternalAgentDriver,
  type SandboxHandle,
} from './headlessDriver';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function makeSource(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-eg-src-'));
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PACKET: DelegationTaskPacket = { prompt: 'do the thing', allowed_write_set: ['a.ts'] };
const LIMITS: DelegationLimits = { max_cost_usd: 1.0, wall_clock_ms: 5_000 };

function compose(cli: CliKind = 'claude', limits: DelegationLimits = LIMITS): ComposedDelegation {
  const c = composeDelegation({ cli, packet: PACKET, source_dir: makeSource(), limits });
  cleanups.push(() => destroyDelegationSandbox(c.sandbox));
  return c;
}

// A mock driver whose event stream we fully control (no real process).
class MockDriver implements ExternalAgentDriver {
  readonly driver = 'headless' as const;
  constructor(private readonly gen: (s: SandboxHandle) => AsyncIterable<AgentEvent>) {}
  run(_p: DelegationTaskPacket, s: SandboxHandle): AsyncIterable<AgentEvent> {
    return this.gen(s);
  }
}

const ev = (kind: AgentEvent['kind'], extra: Partial<AgentEvent> = {}): AgentEvent => ({ cli: 'claude', kind, summary: kind, ...extra });

describe('agent-delegate / entry gate (STORY-033.4)', () => {
  // ── packet_translated_to_sandbox_scope ──
  it('packet_translated_to_sandbox_scope', () => {
    const c = compose('codex');
    expect(c.scope.allowed_write_set).toEqual(['a.ts']);
    expect(c.scope.cwd).toBe(c.sandbox.root);
    expect(c.scope.network.default_action).toBe('deny');
    expect(c.scope.network.allow_registries).toContain('registry.npmjs.org');
    expect(c.handle.cwd).toBe(c.sandbox.root);
    expect(fs.readFileSync(path.join(c.sandbox.root, 'a.ts'), 'utf8')).toContain('export const a = 1;');
    assertNonInteractive(c); // composed invocation is non-interactive
  });

  // ── cost_cap_attached ──
  it('cost_cap_attached: limits attached + Claude native inner cap wired (defense-in-depth)', () => {
    const c = compose('claude', { max_cost_usd: 0.25, wall_clock_ms: 1000 });
    expect(c.limits.max_cost_usd).toBe(0.25);
    // adoption (b): claude --max-budget-usd inner cap == gate cap, set by the gate
    expect(c.native_inner_cap).toBe(true);
    expect(c.packet.max_budget_usd).toBe(0.25);

    // Codex/Gemini have no native cap → gate cap is the only cap (no inner)
    const codex = compose('codex', { max_cost_usd: 0.25, wall_clock_ms: 1000 });
    expect(codex.native_inner_cap).toBe(false);
    expect(codex.packet.max_budget_usd).toBeUndefined();
  });

  it('a caller-set max_budget_usd is preserved (gate does not override)', () => {
    const c = composeDelegation({
      cli: 'claude',
      packet: { ...PACKET, max_budget_usd: 0.05 },
      source_dir: makeSource(),
      limits: LIMITS,
    });
    cleanups.push(() => destroyDelegationSandbox(c.sandbox));
    expect(c.packet.max_budget_usd).toBe(0.05);
    expect(c.native_inner_cap).toBe(false);
  });

  it('rejects non-positive limits', () => {
    const src = makeSource();
    expect(() => composeDelegation({ cli: 'claude', packet: PACKET, source_dir: src, limits: { max_cost_usd: 0, wall_clock_ms: 100 } })).toThrow();
    expect(() => composeDelegation({ cli: 'claude', packet: PACKET, source_dir: src, limits: { max_cost_usd: 1, wall_clock_ms: 0 } })).toThrow();
  });

  it('BudgetLedger tracks cost + tokens and reports exceeded', () => {
    const ledger = new BudgetLedger({ max_cost_usd: 0.10, wall_clock_ms: 1000 }, (t) => t.output * 0.001);
    ledger.charge({ input: 10, output: 50 }); // 0.05
    expect(ledger.exceeded()).toBe(false);
    expect(ledger.remaining_usd()).toBeCloseTo(0.05, 5);
    ledger.charge({ input: 10, output: 80 }); // +0.08 → 0.13 > 0.10
    expect(ledger.exceeded()).toBe(true);
  });

  // ── a normal run completes without a kill ──
  it('normal run completes within limits (not killed)', async () => {
    const c = compose('claude');
    const driver = new MockDriver(async function* () {
      yield ev('message');
      yield ev('completion', { stop_reason: 'end_turn', tokens: { input: 100, output: 40 } });
    });
    const out = await runDelegationGuarded(driver, c, { costEstimator: (t) => t.output * 0.0001 });
    expect(out.killed).toBe(false);
    expect(out.kill_reason).toBeUndefined();
    expect(out.output_tokens).toBe(40);
    expect(out.events.filter((e) => e.kind === 'completion')).toHaveLength(1);
  });

  // ── wall_clock_timeout_enforced + unbounded_run_killed ──
  it('wall_clock_timeout_enforced: a hung/unbounded run is killed and aborted', async () => {
    const c = compose('claude', { max_cost_usd: 1, wall_clock_ms: 25 });
    const controller = new AbortController();
    // a driver that never completes (unbounded) — simulates a runaway agent
    const driver = new MockDriver(async function* () {
      yield ev('message');
      await new Promise<void>(() => {}); // hang forever
    });
    const out = await runDelegationGuarded(driver, c, { controller });
    expect(out.killed).toBe(true);
    expect(out.kill_reason).toBe('wall_clock');
    // the abort signal fired → the child would be killed
    expect(controller.signal.aborted).toBe(true);
    // a terminal killed-completion is always appended
    const last = out.events[out.events.length - 1];
    expect(last.kind).toBe('completion');
    expect(last.stop_reason).toBe('cancelled');
    expect(last.raw).toMatchObject({ killed: true, kill_reason: 'wall_clock' });
  });

  // ── budget kill ──
  it('budget cap exceeded kills the run', async () => {
    const c = compose('claude', { max_cost_usd: 0.01, wall_clock_ms: 5_000 });
    const controller = new AbortController();
    const driver = new MockDriver(async function* () {
      yield ev('message');
      // a completion whose tokens blow the cap via the estimator
      yield ev('completion', { stop_reason: 'end_turn', tokens: { input: 1000, output: 1000 } });
      yield ev('message'); // would continue, but we should have killed already
    });
    const out = await runDelegationGuarded(driver, c, { controller, costEstimator: (t) => t.output * 0.001 });
    expect(out.killed).toBe(true);
    expect(out.kill_reason).toBe('budget');
    expect(controller.signal.aborted).toBe(true);
    expect(out.spent_usd).toBeGreaterThan(0.01);
  });
});
