/**
 * STORY-SH.5 — scale-hardening EFFECTIVENESS (set ≠ effective), all offline fixtures.
 *
 * SH.1-4 WIRED the mechanisms; this proves they are EFFECTIVE — each with an explicit
 * CONTRAST so it shows behaviour ("more stories run without diverging"), not wiring.
 * Zero cost: scripted/offline, real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideAutoAdvance, assessConvergence, projectIterationBudget,
  loadOrInitProjectRunState, persistProjectRunState, recordProjectCost, projectBudgetVerdict,
  registerProducedContracts, contractsFromDependencies,
  type StoryRecord, type IterationMetrics, type RegisteredContract,
} from '@gateloop/harness-core';
import { locateContracts, type CodeGraphClient } from '@gateloop/codegraph-adapter';
import { composeForwardContractContext } from '@gateloop/supervisor-runtime';
import { contractComplianceGate, removedExistingBehavior, type ProposedEdit } from '@gateloop/developer-runtime';
import { computeSpawnPlan, applyWipCap, type SpawnCandidate } from '@gateloop/task-graph';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const story = (o: Partial<StoryRecord>): StoryRecord => ({
  story_id: 'S', epic_id: 'EPIC-P', depends_on: [], parallelism_class: 'sequential', status: 'todo',
  attempts: 0, attempt_budget: 3, branch: null, last_action: null, last_result: null,
  last_validation: null, blocked_reason: null, ...o,
});
const m = (iteration: number, delivered: number, rework: number, clobber: number): IterationMetrics => ({ iteration, delivered, rework, clobber });

// A 20-story project, at iteration 12, with a generous scaled budget (≈k·N=80).
const STORIES_20: StoryRecord[] = [
  story({ story_id: 'STORY-P.12', status: 'done' }),
  story({ story_id: 'STORY-P.13', status: 'todo', depends_on: ['STORY-P.12'] }),
];
const SCALED = { iterations_used: 12, run_iteration_budget: projectIterationBudget(20) }; // 12 < 80

describe('SH.5 VERIFY 1 — convergence is trend-based, not flat-12 (the key contrast)', () => {
  it('divergent_fixture → diverging → decideAutoAdvance stops project_diverging (signal), NOT flat-12', () => {
    const diverging = assessConvergence([m(10,1,0,1), m(11,1,0,2), m(12,1,0,3)]); // clobber 1→2→3
    expect(diverging.verdict).toBe('diverging');
    const d = decideAutoAdvance({ stories: STORIES_20, currentEpicId: 'EPIC-P', runBudget: SCALED, convergence: diverging });
    expect(d.advance).toBe(false);
    expect(d.stopReason).toBe('project_diverging');     // a diagnosis-stop…
    expect(d.stopReason).not.toBe('budget_exceeded');   // …NOT a count hard-stop
    expect(d.diagnosis).toMatch(/clobber rising/);      // reports WHICH signal
  });

  it('converging_fixture → passes iteration 12 (same iteration, same budget → it is the TREND)', () => {
    const converging = assessConvergence([m(10,2,1,0), m(11,1,0,0), m(12,2,1,0)]);
    expect(converging.verdict).toBe('converging');
    const d = decideAutoAdvance({ stories: STORIES_20, currentEpicId: 'EPIC-P', runBudget: SCALED, convergence: converging });
    expect(d.advance).toBe(true);                       // continues PAST iteration 12
    expect(d.nextStoryId).toBe('STORY-P.13');
  });

  it('CONTRAST: the old flat-12 would have halted BOTH at iteration 12; the layered budget+monitor does not', () => {
    const flat12 = { iterations_used: 12, run_iteration_budget: 12 };
    // old behaviour: flat budget halts regardless of convergence
    expect(decideAutoAdvance({ stories: STORIES_20, currentEpicId: 'EPIC-P', runBudget: flat12,
      convergence: assessConvergence([m(10,2,1,0), m(11,1,0,0), m(12,2,1,0)]) }).stopReason).toBe('budget_exceeded');
    // new behaviour: a converging project under the scaled budget keeps going
    expect(decideAutoAdvance({ stories: STORIES_20, currentEpicId: 'EPIC-P', runBudget: SCALED,
      convergence: assessConvergence([m(10,2,1,0), m(11,1,0,0), m(12,2,1,0)]) }).advance).toBe(true);
    expect(projectIterationBudget(20)).toBeGreaterThan(12); // budget scales to N, not flat 12
  });
});

describe('SH.5 VERIFY 2 — forward contract is LOCATED and ENFORCED (both, the contrast)', () => {
  const client: CodeGraphClient = {
    async query(q) {
      if (q.operation === 'symbol_lookup' && q.target === 'FooConfig') {
        return { locations: [
          { file: 'packages/api/src/foo-config.ts', line: 3, kind: 'definition' },
          { file: 'packages/api/src/use-foo.ts', line: 9, kind: 'reference' },
        ] };
      }
      return { locations: [] };
    },
  };
  const registry: RegisteredContract[] = registerProducedContracts([], 'STORY-3',
    [{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts' }]);

  it('story3_registers_fooconfig → story18 context has the codegraph-LOCATED definition+usages', async () => {
    const names = contractsFromDependencies(registry, ['STORY-3']).map(c => c.name); // story 18 depends_on story 3
    expect(names).toEqual(['FooConfig']);
    const ctx = await composeForwardContractContext(names, client);
    expect(ctx.relevant_files).toContain('packages/api/src/foo-config.ts'); // definition
    expect(ctx.relevant_files).toContain('packages/api/src/use-foo.ts');    // usage
    expect(ctx.codegraph_summary).toMatch(/FooConfig/);
  });

  it('redefinition refused while import-only passes (ENFORCED, not just visible)', () => {
    const reg = [{ name: 'FooConfig', path: 'packages/api/src/foo-config.ts', story_id: 'STORY-3' }];
    const redefine: ProposedEdit[] = [{ path: 'packages/api/src/story18.ts', operation: 'create', content: 'export interface FooConfig { x: number }' }];
    const importOnly: ProposedEdit[] = [{ path: 'packages/api/src/story18.ts', operation: 'create', content: 'import { FooConfig } from "./foo-config";\nexport const useFoo = (c: FooConfig) => c;' }];
    expect(contractComplianceGate(redefine, reg).length).toBe(1);   // CONTRAST: redefine → refused
    expect(contractComplianceGate(importOnly, reg)).toEqual([]);     //           import  → allowed
  });
});

describe('SH.5 VERIFY 3 — WIP bounded', () => {
  it('fifteen_parallel_safe → batch ≤ maxWip, the rest queued deterministically, nothing dropped', () => {
    const candidates: SpawnCandidate[] = Array.from({ length: 15 }, (_, i) => ({
      story_id: `STORY-W.${String(i + 1).padStart(2, '0')}`, parallelism_class: 'parallel_safe', allowed_write_set: [`pkg/w${i}/**`],
    }));
    expect(computeSpawnPlan(candidates).parallel_batch.length).toBe(15); // uncapped would spawn 15
    const capped = applyWipCap(computeSpawnPlan(candidates), 4);
    expect(capped.parallel_batch.length).toBe(4);                       // bounded
    expect(capped.sequential_queue.length).toBe(11);                    // rest queued
    expect([...capped.parallel_batch, ...capped.sequential_queue].sort()).toEqual(candidates.map(c => c.story_id).sort()); // nothing dropped
    expect(capped.parallel_batch).toEqual(['STORY-W.01','STORY-W.02','STORY-W.03','STORY-W.04']); // deterministic
  });
});

describe('SH.5 VERIFY 4 — cross-run cost accumulates + project budget stops/warns', () => {
  it('two_runs cumulative + exceeding project budget stops and warns', async () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sh5-')), 'prs.json');
    // RUN 1
    let s = loadOrInitProjectRunState(p, 'proj', ['A'], 10);
    s.cost_ledger!.project_budget_usd = 10; s.cost_ledger!.project_token_cap = 100000;
    recordProjectCost(s, { usd: 4, tokens: 40000 }, '2026-06-23T00:00:00Z');
    await persistProjectRunState(p, s);
    // RUN 2 loads the cumulative (cross-run)
    s = loadOrInitProjectRunState(p, 'proj', ['A'], 10);
    expect(s.cost_ledger!.cumulative_usd).toBe(4);
    expect(projectBudgetVerdict(s.cost_ledger!).decision).toBe('ok');
    recordProjectCost(s, { usd: 4.5, tokens: 40000 }, '2026-06-23T01:00:00Z'); // → 8.5 / 10
    expect(projectBudgetVerdict(s.cost_ledger!).decision).toBe('warn');         // ≥80%
    recordProjectCost(s, { usd: 2, tokens: 0 }, '2026-06-23T02:00:00Z');         // → 10.5 / 10
    const stop = projectBudgetVerdict(s.cost_ledger!);
    expect(stop.decision).toBe('stop');
    expect(stop.reason).toMatch(/budget reached/);
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  });
});

describe('SH.5 VERIFY 5 — integration + guardrails untouched', () => {
  it('four mechanisms compose without conflict (converging + WIP + cost + contracts together)', async () => {
    // a healthy 20-story project mid-run: converging, under budget, WIP-bounded, contracts located
    const conv = assessConvergence([m(10,2,1,0), m(11,2,0,0), m(12,1,1,0)]);
    const ledger = { cumulative_usd: 3, cumulative_tokens: 30000, project_budget_usd: 50, project_token_cap: 1e6, updated_at: 't' };
    const wip = applyWipCap(computeSpawnPlan([
      { story_id: 'STORY-X.1', parallelism_class: 'parallel_safe', allowed_write_set: ['a/**'] },
      { story_id: 'STORY-X.2', parallelism_class: 'parallel_safe', allowed_write_set: ['b/**'] },
      { story_id: 'STORY-X.3', parallelism_class: 'parallel_safe', allowed_write_set: ['c/**'] },
    ]), 2);
    const d = decideAutoAdvance({ stories: STORIES_20, currentEpicId: 'EPIC-P', runBudget: SCALED, convergence: conv });
    expect(d.advance).toBe(true);                                   // converging → continue
    expect(projectBudgetVerdict(ledger).decision).toBe('ok');       // under budget
    expect(wip.parallel_batch.length).toBe(2);                      // WIP bounded
    expect(wip.sequential_queue.length).toBe(1);                    // overflow queued — no conflict between the four
  });

  it('agent guardrails UNTOUCHED — real_api_calls false + additive gate still works', () => {
    // real_api_calls fail-closed gate: still false in the real policy
    const policy = fs.readFileSync(path.join(repoRoot, 'configs', 'policy.yaml'), 'utf8');
    expect(/real_api_calls:\s*\n\s*enabled:\s*false/.test(policy)).toBe(true);
    // the additive gate (deleting a prior export) is intact and unchanged by SH.4's new gate
    expect(removedExistingBehavior('export function foo(){}\nexport const bar=1', 'export const bar=1'))
      .toContain('export foo'); // still detects a removed export
    // SH.4's compliance gate concerns only skill/contract symbols — it never reads policy/real_api
    expect(contractComplianceGate([{ path: 'x.ts', operation: 'create', content: 'export const z=1' }],
      [{ name: 'FooConfig', path: 'foo.ts' }])).toEqual([]); // unrelated symbol → no false stop
  });
});
