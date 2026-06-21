/**
 * STORY-UST.4 WORK 2 (offline) — the ponytail three-fold CHECKING MACHINERY:
 *   code↓  ∧  correctness held  ∧  no added friction.
 *
 * Scripted providers ignore the prompt, so they cannot themselves show a model
 * "writing less" — that behavioural proof is the gated real-model arm. What this
 * offline test proves rigorously (zero cost) is that the measurement + the gates +
 * the ADR-023 §3.3 coordination are sound:
 *   - a BOUNDED-lazy patch (ponytail-correct: fewer lines, preserves existing exports)
 *     scores lower LOC/files, still passes acceptance, and adds NO friction;
 *   - a NAIVE-lazy patch (what ponytail WITHOUT the §3.3 deletion-binding would do —
 *     strip an existing export to "simplify") is REJECTED by the additive gate.
 *     That rejection is exactly the friction the coordination edit prevents, so the
 *     edit is load-bearing, not decorative.
 *
 * Offline; real_api_calls untouched.
 */
import { describe, it, expect } from 'vitest';
import { producePatchProposal, type DeveloperTaskPacketView } from '@gateloop/developer-runtime';
import {
  ProviderRegistry, createScriptedProvider,
  type RoutingConfig, type AgentStructuredOutput,
} from '@gateloop/model-gateway';
import type { AskModelDeps } from '@gateloop/agent-core';
import { measureArm, abVerdict, type MeasuredProposal } from '../scripts/ust4-ab.ts';

const ROUTING: RoutingConfig = { agents: { developer: { primary: 'scripted-dev' } } };
const FIXED = '2026-06-21T00:00:00.000Z';

function deps(output: AgentStructuredOutput): AskModelDeps {
  const registry = new ProviderRegistry();
  registry.register(createScriptedProvider('scripted-dev', [{ case_id: 'dev', match: { target_agent: 'developer' }, output }]));
  return { registry, routing: ROUTING };
}

const WRITE_SET = ['gateloop/packages/api/src/**'];
const PACKET: DeveloperTaskPacketView = {
  story_id: 'STORY-AB.1',
  contract_version: 1,
  allowed_write_set: WRITE_SET,
  acceptance_criteria: ['formats_currency'],
  // an existing shared file with an exported helper that must be preserved
  current_files: {
    'gateloop/packages/api/src/money.ts':
      'export function formatCents(c: number): string { return `$${(c/100).toFixed(2)}`; }\nexport function parseMoney(s: string): number { return Math.round(parseFloat(s.replace("$","")) * 100); }',
  },
};

// Baseline (no ponytail): an over-built solution — a class + a config + 3 files.
const BASELINE_OUT = {
  kind: 'patch_proposal', proposal_id: 'PP-AB-base', story_id: 'STORY-AB.1',
  summary: 'CurrencyFormatter service with config + factory', change_type: 'new_impl',
  changed_files: [
    'gateloop/packages/api/src/currency-formatter.ts',
    'gateloop/packages/api/src/currency-config.ts',
    'gateloop/packages/api/src/currency-factory.ts',
  ],
  edits: [
    { path: 'gateloop/packages/api/src/currency-formatter.ts', operation: 'create',
      content: 'export interface ICurrencyFormatter { format(c: number): string; }\nexport class CurrencyFormatter implements ICurrencyFormatter {\n  constructor(private cfg: CurrencyConfig) {}\n  format(c: number): string {\n    const sym = this.cfg.symbol;\n    const dp = this.cfg.decimals;\n    return `${sym}${(c/100).toFixed(dp)}`;\n  }\n}' },
    { path: 'gateloop/packages/api/src/currency-config.ts', operation: 'create',
      content: 'export interface CurrencyConfig { symbol: string; decimals: number; }\nexport const DEFAULT_CONFIG: CurrencyConfig = { symbol: "$", decimals: 2 };' },
    { path: 'gateloop/packages/api/src/currency-factory.ts', operation: 'create',
      content: 'import { CurrencyFormatter } from "./currency-formatter";\nimport { DEFAULT_CONFIG } from "./currency-config";\nexport function makeFormatter() { return new CurrencyFormatter(DEFAULT_CONFIG); }' },
  ],
  postconditions_claimed: ['formats_currency'],
  rationale_summary: 'A configurable currency formatter service with a factory for future flexibility.',
  rollback_notes: 'delete the three currency-* files',
} as AgentStructuredOutput;

// Ponytail arm (bounded-lazy): one tiny function, one new file, existing exports untouched.
const PONYTAIL_OUT = {
  kind: 'patch_proposal', proposal_id: 'PP-AB-pony', story_id: 'STORY-AB.1',
  summary: 'one-line currency formatter', change_type: 'new_impl',
  changed_files: ['gateloop/packages/api/src/format-currency.ts'],
  edits: [
    { path: 'gateloop/packages/api/src/format-currency.ts', operation: 'create',
      content: '// ponytail: stdlib toFixed covers it; add a config only when a second currency appears\nexport const formatCurrency = (cents: number): string => `$${(cents/100).toFixed(2)}`;' },
  ],
  postconditions_claimed: ['formats_currency'],
  rationale_summary: 'ponytail: one line over a service; stdlib toFixed; no new dependency; existing money.ts untouched.',
  rollback_notes: 'delete gateloop/packages/api/src/format-currency.ts',
} as AgentStructuredOutput;

// Naive-lazy (ponytail WITHOUT the §3.3 deletion binding): rewrites money.ts and DROPS
// the existing exported parseMoney to "simplify" — must be rejected by the additive gate.
const NAIVE_LAZY_OUT = {
  kind: 'patch_proposal', proposal_id: 'PP-AB-naive', story_id: 'STORY-AB.1',
  summary: 'simplify money.ts', change_type: 'new_impl',
  changed_files: ['gateloop/packages/api/src/money.ts'],
  edits: [
    { path: 'gateloop/packages/api/src/money.ts', operation: 'modify',
      content: 'export function formatCents(c: number): string { return `$${(c/100).toFixed(2)}`; }' }, // parseMoney removed!
  ],
  postconditions_claimed: ['formats_currency'],
  rationale_summary: 'dropped parseMoney, looked unused',
  rollback_notes: 'restore money.ts',
} as AgentStructuredOutput;

describe('STORY-UST.4 WORK 2 — ponytail three-fold (offline machinery)', () => {
  it('bounded-lazy: code↓ ∧ correctness held ∧ no added friction', async () => {
    const base = await producePatchProposal(PACKET, deps(BASELINE_OUT), { proposedAt: FIXED, mountedSkills: [] });
    const pony = await producePatchProposal(PACKET, deps(PONYTAIL_OUT), { proposedAt: FIXED, mountedSkills: [] });
    expect(base.ok).toBe(true);
    expect(pony.ok).toBe(true);

    const toMeasured = (r: typeof base): MeasuredProposal => ({
      ok: r.ok,
      changed_files: r.proposal?.changed_files,
      edits: r.proposal?.edits,
      rejected_paths: r.rejected_paths,
      errors: r.errors,
    });
    const baseArm = measureArm('baseline', toMeasured(base));
    const ponyArm = measureArm('ponytail', toMeasured(pony));
    const v = abVerdict(baseArm, ponyArm);

    expect(v.loc_not_increased).toBe(true);     // code↓
    expect(v.files_not_increased).toBe(true);    // fewer files
    expect(ponyArm.loc).toBeLessThan(baseArm.loc);
    expect(v.correctness_held).toBe(true);       // both produced an accepted, additive patch
    expect(v.no_added_friction).toBe(true);      // ponytail added no rejection/escalation
    expect(v.three_fold_pass).toBe(true);
    // both still claim the contracted postcondition (lazy didn't drop the requirement)
    expect(pony.proposal!.postconditions_claimed).toContain('formats_currency');
  });

  it('naive-lazy (no §3.3 binding) is rejected by the additive gate — the friction ponytail avoids', async () => {
    const naive = await producePatchProposal(PACKET, deps(NAIVE_LAZY_OUT), { proposedAt: FIXED, mountedSkills: [] });
    expect(naive.ok).toBe(false);
    expect(naive.errors.join(' ')).toMatch(/additive|removes existing|parseMoney/i);
    // This is exactly why ponytail's deletion rung is bounded: without it, "simplify"
    // strips an existing export and the gate rejects it (added friction). With the
    // §3.3 binding, the ponytail arm above never goes there → no friction.
  });
});
