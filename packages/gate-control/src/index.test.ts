/**
 * Plan §0.2 — the six guardrail proofs. Full-auto gating is only trustworthy if
 * every guardrail is FIXTURE-PROVEN to fire (like Developer Observe), not merely
 * configured. Zero cost: in-memory IO + temp policy, no real API, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  readGate, setGateEnabled, isGatedAllowed, runGated,
  BudgetLedger, TokenCapGuard, type GateIO,
} from './index';

const POLICY = (enabled: boolean, kill = false, ci = false) =>
  `policy_version: 1\n` +
  `real_api_calls:\n` +
  `  enabled: ${enabled} # comment\n` +
  `  kill_switch: ${kill}\n` +
  `  ci_override: ${ci}\n` +
  `quality_bar:\n  x: 1\n`;

/** In-memory IO so writes/read-backs are deterministic and silent failures injectable. */
function memIO(initial: string, opts: { blockWritesAfter?: number } = {}): GateIO & { dump(): string; writes: number } {
  let content = initial;
  let writes = 0;
  return {
    read: () => content,
    write: (_p, c) => { writes++; if (opts.blockWritesAfter !== undefined && writes > opts.blockWritesAfter) return; content = c; },
    dump: () => content,
    get writes() { return writes; },
  };
}
const PATH = '/virtual/policy.yaml';

describe('gate-control §0.2 — the six guardrails (fixture-proven)', () => {
  // ── 1. per-run TOKEN CAP triggers and hard-stops ──────────────────────────
  it('1. token cap: record returns false at the cap and stays killed', () => {
    const g = new TokenCapGuard(1000);
    expect(g.record(400)).toBe(true);
    expect(g.record(400)).toBe(true);
    expect(g.record(400)).toBe(false);   // 1200 >= 1000 → hard stop
    expect(g.killReason()).toMatch(/token cap reached: 1200 \/ 1000/);
    expect(g.killed()).toBe(true);
    expect(g.allowed()).toBe(false);
    expect(g.record(1)).toBe(false);      // stays killed; no further calls allowed
    expect(g.used()).toBe(1201);
  });

  // ── 2. KILL SWITCH blocks any gated run ───────────────────────────────────
  it('2. kill switch: no gated run may start even with gate enabled', () => {
    expect(isGatedAllowed({ enabled: true, killSwitch: true, ciOverride: false }).allowed).toBe(false);
    expect(isGatedAllowed({ enabled: true, killSwitch: true, ciOverride: false }).reason).toMatch(/kill switch/);
  });

  // ── 3. BUDGET CEILING refuses a new run when cumulative spend is over ──────
  it('3. budget ceiling: refuses a new run at/over the ceiling', () => {
    const b = new BudgetLedger(1.0, 0.0);
    expect(b.canStart(0.3).allowed).toBe(true);
    b.record(0.6); b.record(0.5);                       // spent 1.1 > 1.0
    expect(b.canStart().allowed).toBe(false);
    expect(b.canStart().reason).toMatch(/budget ceiling reached/);
    // also refuses when the run ESTIMATE would cross the ceiling
    const b2 = new BudgetLedger(1.0, 0.8);
    expect(b2.canStart(0.5).allowed).toBe(false);       // 0.8 + 0.5 > 1.0
    expect(b2.canStart(0.1).allowed).toBe(true);
  });

  // ── 4. AUTO-CLOSE + read-back verify ──────────────────────────────────────
  it('4. auto-close: runGated opens, runs, and closes the gate (read-back confirms false)', async () => {
    const io = memIO(POLICY(false));
    let sawOpenDuringRun = false;
    const r = await runGated(async () => {
      sawOpenDuringRun = readGate(PATH, io).enabled;   // gate is open WHILE fn runs
      return 'work-done';
    }, { policyPath: PATH, env: {}, io });
    expect(sawOpenDuringRun).toBe(true);
    expect(r.ran).toBe(true);
    expect(r.result).toBe('work-done');
    expect(r.gateClosedVerified).toBe(true);
    expect(readGate(PATH, io).enabled).toBe(false);    // actually closed afterwards
  });

  it('4b. auto-close fires even when the run THROWS', async () => {
    const io = memIO(POLICY(false));
    await expect(runGated(async () => { throw new Error('boom'); }, { policyPath: PATH, env: {}, io }))
      .rejects.toThrow(/boom/);
    expect(readGate(PATH, io).enabled).toBe(false);    // still closed despite the throw
  });

  // ── 5. SILENT-FAILURE detection (the 6/15 defense) ────────────────────────
  it('5a. setGateEnabled surfaces a write that did not take (verified:false + error)', () => {
    const io = memIO(POLICY(false), { blockWritesAfter: 0 }); // every write is a no-op
    const res = setGateEnabled(PATH, true, io);
    expect(res.ok).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.actual).toBe(false);                    // read-back caught it
    expect(res.error).toMatch(/NOT verified/);
  });

  it('5b. runGated THROWS CRITICAL if the auto-close write silently fails', async () => {
    // First write (open) succeeds; the close write is blocked → read-back still true.
    const io = memIO(POLICY(false), { blockWritesAfter: 1 });
    await expect(runGated(async () => 'x', { policyPath: PATH, env: {}, io }))
      .rejects.toThrow(/CRITICAL: gate auto-close NOT verified/);
    // and the gate is indeed still open — the loud error is correct, not paranoid.
    expect(readGate(PATH, io).enabled).toBe(true);
  });

  // ── 6. CI NEVER GATED ─────────────────────────────────────────────────────
  it('6. CI never gated: ci_override + CI env blocks the run; gate never opens', async () => {
    expect(isGatedAllowed({ enabled: true, killSwitch: false, ciOverride: true }, { CI: '1' }).allowed).toBe(false);
    const io = memIO(POLICY(false, false, true));
    const r = await runGated(async () => 'should-not-run', { policyPath: PATH, env: { CI: 'true' }, io });
    expect(r.ran).toBe(false);
    expect(r.reason).toMatch(/CI/);
    expect(io.writes).toBe(0);                          // gate was never even opened
    expect(readGate(PATH, io).enabled).toBe(false);
  });

  // ── round-trip sanity on a realistic policy shape ─────────────────────────
  it('reads enabled/kill/ci from a realistic policy block and flips only enabled', () => {
    const io = memIO(POLICY(false, false, true));
    expect(readGate(PATH, io)).toEqual({ enabled: false, killSwitch: false, ciOverride: true });
    expect(setGateEnabled(PATH, true, io).verified).toBe(true);
    expect(readGate(PATH, io)).toEqual({ enabled: true, killSwitch: false, ciOverride: true });
    expect(io.dump()).toMatch(/kill_switch: false/);   // untouched
    expect(io.dump()).toMatch(/ci_override: true/);    // untouched
  });
});

// ── STORY-GATE.3: policy gate only stops guardrail-weakening changes ──
import { classifyPolicyChange, diffPolicy } from './index.ts';

describe('STORY-GATE.3 classifyPolicyChange', () => {
  it('examples_routing_model_budget_skill_toggle_apply_and_log', () => {
    const before = { routing: { developer: 'a' }, model: 'gpt', budgets: { run_iteration_budget: 12 }, skills: { 'developer.ponytail-lazy': { enabled: true } } };
    const after  = { routing: { developer: 'b' }, model: 'gpt-5', budgets: { run_iteration_budget: 20 }, skills: { 'developer.ponytail-lazy': { enabled: false } } };
    const c = classifyPolicyChange(before, after);
    expect(c.decision).toBe('apply_and_log');
    expect(c.weakensGuardrail).toBe(false);
    expect(c.changedKeys.length).toBeGreaterThan(0); // it DID detect changes, just benign ones
  });

  it('guardrail_weakening_policy_change_still_stops — real_api_calls enable', () => {
    const c = classifyPolicyChange({ real_api_calls: { enabled: false } }, { real_api_calls: { enabled: true } });
    expect(c.decision).toBe('stop');
    expect(c.reasons.join(' ')).toMatch(/spending enabled/);
  });

  it('examples_writeset_loosen_defaultdeny_off_isolation_lower_stop', () => {
    // write-set widened
    expect(classifyPolicyChange({ allowed_write_set: ['pkg/a/**'] }, { allowed_write_set: ['pkg/a/**', 'pkg/b/**'] }).decision).toBe('stop');
    // default-deny turned off
    expect(classifyPolicyChange({ tool_policy: { default_deny: true } }, { tool_policy: { default_deny: false } }).decision).toBe('stop');
    // tools gained shell
    expect(classifyPolicyChange({ allowed_tools: ['read'] }, { allowed_tools: ['read', 'bash'] }).decision).toBe('stop');
    // network opened
    expect(classifyPolicyChange({ isolation: { network: false } }, { isolation: { network: true } }).decision).toBe('stop');
    // sandbox disabled
    expect(classifyPolicyChange({ sandbox: { enabled: true } }, { sandbox: { enabled: false } }).decision).toBe('stop');
  });

  it('classifier_explicit_and_conservative_unsure_treated_as_weakening', () => {
    // an unrecognised key that isn't provably benign → conservative stop
    const c = classifyPolicyChange({ mystery_flag: 1 }, { mystery_flag: 2 });
    expect(c.decision).toBe('stop');
    expect(c.reasons.join(' ')).toMatch(/unrecognised|conservative/);
  });

  it('strengthening a guardrail is not a stop (real_api_calls off, write-set narrowed)', () => {
    expect(classifyPolicyChange({ real_api_calls: { enabled: true } }, { real_api_calls: { enabled: false } }).decision).toBe('apply_and_log');
    expect(classifyPolicyChange({ allowed_write_set: ['a/**', 'b/**'] }, { allowed_write_set: ['a/**'] }).decision).toBe('apply_and_log');
  });

  it('diffPolicy detects nested leaf changes', () => {
    expect(diffPolicy({ a: { b: 1 } }, { a: { b: 2 } }).map(c => c.key)).toEqual(['a.b']);
    expect(diffPolicy({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

// ── STORY-SH.1: seed a per-run BudgetLedger from the durable project cost ledger ──
import { seedBudgetLedgerFromProjectCost } from './index.ts';
describe('STORY-SH.1 seedBudgetLedgerFromProjectCost (reuse initialSpentUsd, no rebuild)', () => {
  it('each_run_loads_cumulative_seeds_budgetledger_via_initial_spent_usd', () => {
    // prior runs already spent $7 of a $10 project budget
    const led = seedBudgetLedgerFromProjectCost({ cumulative_usd: 7, project_budget_usd: 10 });
    expect(led.spent()).toBe(7);          // seeded from cumulative (initialSpentUsd)
    expect(led.remaining()).toBe(3);      // project ceiling minus prior runs
    expect(led.canStart(2).allowed).toBe(true);
    expect(led.canStart(4).allowed).toBe(false); // 7+4 > 10 → refuse this run
  });
  it('uncapped project → Infinity ceiling (per-run TokenCapGuard still bounds a run)', () => {
    const led = seedBudgetLedgerFromProjectCost({ cumulative_usd: 999999, project_budget_usd: null });
    expect(led.canStart(100).allowed).toBe(true);
  });
});
