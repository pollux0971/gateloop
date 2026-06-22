/**
 * STORY-SH.4 — forward type contracts × codegraph synergy × compliance gate.
 *
 * The keystone synergy: the registry records WHAT each story produced (facts on the
 * handoff card); codegraph resolves WHERE it lives now (authoritative); the compliance
 * gate blocks a later story REDEFINING it. Reuses HandoffCard + additive-gate precedent +
 * codegraph adapter (real after EPIC-CW). Offline/scripted.
 */
import { describe, it, expect } from 'vitest';
import {
  emitHandoffCard, assertHandoffCardFactsOnly,
  registerProducedContracts, contractsFromDependencies,
  type RegisteredContract, type StoryCompletionFacts,
} from '@gateloop/harness-core';
import { locateContracts, type CodeGraphClient } from '@gateloop/codegraph-adapter';
import { composeForwardContractContext } from '@gateloop/supervisor-runtime';
import { contractComplianceGate, type ProposedEdit } from '@gateloop/developer-runtime';

// A fixture codegraph client that knows FooConfig lives at the registered path (the "real"
// engine would return this; here it's deterministic). Stands in for EPIC-CW's live client.
const fixtureClient: CodeGraphClient = {
  async query(q) {
    if (q.operation === 'symbol_lookup' && q.target === 'FooConfig') {
      return { locations: [
        { file: 'packages/api/src/foo-config.ts', line: 3, kind: 'definition' },
        { file: 'packages/api/src/consumer.ts', line: 12, kind: 'reference' },
      ] };
    }
    return { locations: [], impacted_files: [] };
  },
};

describe('STORY-SH.4 produced_contracts are FACTS (facts-only preserved)', () => {
  it('handoff_card_carries_produced_contracts_as_facts_not_inference', () => {
    const facts: StoryCompletionFacts = {
      story_id: 'STORY-3', delivered: ['FooConfig type'], touched_files: ['packages/api/src/foo-config.ts'],
      acceptance: { result: 'pass' }, trace_ref: 'trace#1',
      produced_contracts: [{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts', signature_ref: 'trace#1' }],
      // smuggled reasoning — must be dropped
      reasoning: 'I chose an interface because...', rationale: 'because',
    };
    const card = emitHandoffCard(facts);
    expect(card.produced_contracts).toEqual([{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts', signature_ref: 'trace#1' }]);
    // facts-only invariant still holds: reasoning was NOT copied
    expect(assertHandoffCardFactsOnly(card as any)).toEqual([]);
    expect((card as any).reasoning).toBeUndefined();
    expect((card as any).rationale).toBeUndefined();
  });
});

describe('STORY-SH.4 registry accumulates + dependency lookup', () => {
  it('contracts_accumulate_cross_story_into_registry + story18_dependson_story3_takes_names', () => {
    let reg: RegisteredContract[] = [];
    reg = registerProducedContracts(reg, 'STORY-3', [{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts' }]);
    reg = registerProducedContracts(reg, 'STORY-7', [{ name: 'BarService', kind: 'class', path: 'packages/api/src/bar.ts' }]);
    reg = registerProducedContracts(reg, 'STORY-3', [{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts' }]); // dup ignored
    expect(reg.length).toBe(2);
    // story 18 depends_on story 3 → its forward contracts are story 3's
    const forStory18 = contractsFromDependencies(reg, ['STORY-3']);
    expect(forStory18.map(c => c.name)).toEqual(['FooConfig']);
  });
});

describe('STORY-SH.4 codegraph synergy: registry says WHAT, codegraph says WHERE NOW', () => {
  it('codegraph_locates_live_definition_and_usages_injects_into_story18_context', async () => {
    const reg: RegisteredContract[] = registerProducedContracts([], 'STORY-3', [{ name: 'FooConfig', kind: 'interface', path: 'packages/api/src/foo-config.ts' }]);
    const names = contractsFromDependencies(reg, ['STORY-3']).map(c => c.name);
    // the adapter resolves the LIVE location (authoritative), not the registered string
    const located = await locateContracts(names, fixtureClient);
    expect(located[0].located).toBe(true);
    expect(located[0].locations.map(l => l.file)).toContain('packages/api/src/foo-config.ts');
    // the Supervisor folds it into story 18's context (relevant_files / codegraph_summary)
    const ctx = await composeForwardContractContext(names, fixtureClient);
    expect(ctx.relevant_files).toContain('packages/api/src/foo-config.ts');
    expect(ctx.relevant_files).toContain('packages/api/src/consumer.ts');
    expect(ctx.codegraph_summary).toMatch(/FooConfig/);
    expect(ctx.codegraph_summary).toMatch(/do not redefine/);
  });

  it('registry_says_what_codegraph_says_where_now_authoritative (NULL client → unlocated, no crash)', async () => {
    const located = await locateContracts(['FooConfig'], undefined); // NULL_CLIENT default
    expect(located[0].located).toBe(false); // seam/fallback holds without an engine
  });
});

describe('STORY-SH.4 compliance gate: refuse redefinition (codegraph+tsc, no custom checker)', () => {
  const registered = [{ name: 'FooConfig', path: 'packages/api/src/foo-config.ts', story_id: 'STORY-3' }];

  it('compliance_gate_refuses_redefinition_or_signature_contradiction_pre_emit', () => {
    // story 18 REDEFINES FooConfig in a different file → violation
    const redefine: ProposedEdit[] = [
      { path: 'packages/api/src/story18.ts', operation: 'create', content: 'export interface FooConfig { x: number }' },
    ];
    const v = contractComplianceGate(redefine, registered);
    expect(v.length).toBe(1);
    expect(v[0].name).toBe('FooConfig');
    expect(v[0].reason).toMatch(/import it instead/);
  });

  it('importing/consuming the contract passes (no re-export of the registered name)', () => {
    const consume: ProposedEdit[] = [
      { path: 'packages/api/src/story18.ts', operation: 'create',
        content: 'import { FooConfig } from "./foo-config";\nexport const useFoo = (c: FooConfig) => c;' },
    ];
    expect(contractComplianceGate(consume, registered)).toEqual([]); // imports FooConfig, exports useFoo — fine
  });

  it('re-exporting the contract from its OWN registered path is not a redefinition', () => {
    const sameFile: ProposedEdit[] = [
      { path: 'packages/api/src/foo-config.ts', operation: 'modify', content: 'export interface FooConfig { x: number; y?: string }' },
    ];
    expect(contractComplianceGate(sameFile, registered)).toEqual([]); // same path = the owner story may evolve it
  });
});
