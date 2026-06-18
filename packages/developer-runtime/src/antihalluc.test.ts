/**
 * Plan §1 — generation-side anti-hallucination (the "prevent" half; Observe is the
 * "catch" half). Two of the three gaps live in developer-runtime:
 *   §1b — a `modify` that REMOVES existing exported behavior is rejected by the
 *         additive gate (the §C-3 hole: it used to flag only operation==='delete').
 *   §1c — the Developer's working rules now reach the model as a composed system
 *         prompt (the askModel call previously passed none).
 * CI-safe: scripted provider, no model, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  ProviderRegistry, createScriptedProvider,
  type RoutingConfig, type ModelProvider, type ModelGatewayRequest, type AgentStructuredOutput,
} from '@gateloop/model-gateway';
import {
  producePatchProposal, removedExistingBehavior, developerSystemPromptBase,
  type DeveloperTaskPacketView, type AskModelDeps,
} from './index';

const ROUTING: RoutingConfig = { agents: { developer: { primary: 'scripted-dev' } } };
const FIXED = '2026-06-19T00:00:00.000Z';

function depsReturning(output: AgentStructuredOutput): AskModelDeps {
  const registry = new ProviderRegistry();
  registry.register(createScriptedProvider('scripted-dev', [{ case_id: 'dev', match: { target_agent: 'developer' }, output }]));
  return { registry, routing: ROUTING };
}

// ── §1b: modify-removes-existing-behavior detection ──────────────────────────

describe('§1b — additive gate rejects a modify that removes existing behavior', () => {
  it('removedExistingBehavior: reports exports present in old but gone from new', () => {
    const old = 'export function add(a,b){return a+b;}\nexport function mul(a,b){return a*b;}\n';
    expect(removedExistingBehavior(old, 'export function add(a,b){return a+b;}\n')).toEqual(['export mul']);
    // adding a new export removes nothing
    expect(removedExistingBehavior(old, old + 'export function sub(a,b){return a-b;}\n')).toEqual([]);
    // keeping all exports (even with changed bodies) removes nothing — body changes are Observe's job
    expect(removedExistingBehavior(old, 'export function add(a,b){return a-b;}\nexport function mul(a,b){return a*b;}\n')).toEqual([]);
  });

  const PACKET_B: DeveloperTaskPacketView = {
    story_id: 'S3',
    allowed_write_set: ['core.mjs'],
    current_files: { 'core.mjs': 'export function add(a,b){return a+b;}\nexport function mul(a,b){return a*b;}\n' },
  };

  it('a modify that drops the exported `mul` is rejected as non-additive (the §C-3 hole, now closed)', async () => {
    const clobber = {
      kind: 'patch_proposal', proposal_id: 'PP-S3', story_id: 'S3', summary: 'add sub, accidentally drop mul',
      change_type: 'new_impl', changed_files: ['core.mjs'],
      edits: [{ path: 'core.mjs', operation: 'modify', content: 'export function add(a,b){return a+b;}\nexport function sub(a,b){return a-b;}\n' }],
      rationale_summary: 'add sub', rollback_notes: 'revert core.mjs',
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET_B, depsReturning(clobber), { proposedAt: FIXED });
    expect(r.ok).toBe(false);
    expect(r.proposal).toBeUndefined();
    expect(r.errors.join(' ')).toMatch(/not additive: modify removes existing behavior/);
    expect(r.errors.join(' ')).toMatch(/export mul/);
  });

  it('a modify that KEEPS all exports and adds one is allowed (additive)', async () => {
    const additive = {
      kind: 'patch_proposal', proposal_id: 'PP-S3', story_id: 'S3', summary: 'add sub, keep all',
      change_type: 'new_impl', changed_files: ['core.mjs'],
      edits: [{ path: 'core.mjs', operation: 'modify', content: 'export function add(a,b){return a+b;}\nexport function mul(a,b){return a*b;}\nexport function sub(a,b){return a-b;}\n' }],
      rationale_summary: 'add sub', rollback_notes: 'revert core.mjs',
    } as AgentStructuredOutput;
    const r = await producePatchProposal(PACKET_B, depsReturning(additive), { proposedAt: FIXED });
    expect(r.ok).toBe(true);
    expect(r.proposal!.additive).toBe(true);
  });
});

// ── §1c: the Developer system prompt reaches the model ───────────────────────

describe('§1c — Developer working rules are sent as a composed system prompt', () => {
  const PACKET_C: DeveloperTaskPacketView = { story_id: 'S1', allowed_write_set: ['core.mjs'] };
  const OUT = {
    kind: 'patch_proposal', proposal_id: 'PP-S1', story_id: 'S1', summary: 'impl add',
    change_type: 'new_impl', changed_files: ['core.mjs'],
    edits: [{ path: 'core.mjs', operation: 'create', content: 'export function add(a,b){return a+b;}\n' }],
    rationale_summary: 'add', rollback_notes: 'rm core.mjs',
  } as AgentStructuredOutput;

  it('producePatchProposal sends a system prompt carrying the work rules (was: undefined)', async () => {
    let captured: ModelGatewayRequest | null = null;
    const capturing: ModelProvider = { id: 'scripted-dev', kind: 'scripted', async call(req) { captured = req; return OUT; } };
    const registry = new ProviderRegistry(); registry.register(capturing);
    const r = await producePatchProposal(PACKET_C, { registry, routing: ROUTING }, { proposedAt: FIXED });
    expect(r.ok).toBe(true);
    expect(captured).not.toBeNull();
    const sysPrompt = String((captured!.task_packet as Record<string, unknown>).system_prompt ?? '');
    expect(sysPrompt.length).toBeGreaterThan(0);                       // no longer undefined
    expect(sysPrompt).toMatch(/PRESERVE EXISTING BEHAVIOR/i);          // the §1 rule reaches the model
    expect(sysPrompt).toMatch(/write-set/i);
    expect(sysPrompt).toMatch(/additive/i);
  });

  it('developerSystemPromptBase carries the 03_DEVELOPER_AGENT working rules', () => {
    const base = developerSystemPromptBase();
    expect(base).toMatch(/Localize first/);
    expect(base).toMatch(/Additive-first/);
    expect(base).toMatch(/PRESERVE EXISTING BEHAVIOR/);
    expect(base).toMatch(/do not author your own acceptance tests/i);
  });
});
