import { describe, it, expect } from 'vitest';
import type { AgentEvent, DelegationTaskPacket, SandboxHandle, ExternalAgentDriver, ExitGateContract } from '@gateloop/agent-delegate';
import {
  selectBuilderMode,
  DEFAULT_BUILDER_MODE,
  agentModeProducer,
  cliModeProducer,
  runBuilderMode,
  toDelegationResult,
  type ProducedDiff,
} from './index';

// ── Test fixtures (no real CLI, no real spawn) ────────────────────────────────────

const PACKET: DelegationTaskPacket = { prompt: 'build slugify', allowed_write_set: ['slugify.mjs'] };
const SANDBOX: SandboxHandle = { cwd: '/tmp/sandbox-copy' };
const CONTRACT: ExitGateContract = {
  story_id: 'S1',
  allowed_write_set: ['slugify.mjs'],
  acceptance_criteria: { behaviors_must_pass: ['slugify_lowercases_and_hyphenates_words'] },
};

const IN_SET_DIFF = [
  'diff --git a/slugify.mjs b/slugify.mjs',
  '--- a/slugify.mjs',
  '+++ b/slugify.mjs',
  '+export function slugify(s){return s.toLowerCase();}',
].join('\n');

const OUT_OF_SET_DIFF = [
  'diff --git a/slugify.mjs b/slugify.mjs',
  '+export function slugify(s){return s;}',
  'diff --git a/secret.txt b/secret.txt',
  '+leak',
].join('\n');

/** A scripted/stub ExternalAgentDriver (033 interface) — yields events, spawns nothing. */
function stubDriver(events: AgentEvent[]): ExternalAgentDriver {
  return {
    driver: 'headless',
    async *run(): AsyncIterable<AgentEvent> {
      for (const e of events) yield e;
    },
  };
}

const STUB_EVENTS: AgentEvent[] = [
  { cli: 'claude', kind: 'message', summary: 'wrote slugify.mjs' },
  { cli: 'claude', kind: 'completion', summary: 'done', stop_reason: 'end_turn', tokens: { input: 10, output: 20 } },
];

// ── Behavior: builder_mode_selectable_agent_or_cli_default_agent ──────────────────
describe('builder mode selection', () => {
  it('builder_mode_selectable_agent_or_cli_default_agent', () => {
    expect(DEFAULT_BUILDER_MODE).toBe('agent_mode');
    expect(selectBuilderMode()).toBe('agent_mode');               // nothing → default
    expect(selectBuilderMode({})).toBe('agent_mode');             // empty → default
    expect(selectBuilderMode({ mode: 'cli_mode' })).toBe('cli_mode');
    expect(selectBuilderMode({ mode: 'agent_mode' })).toBe('agent_mode');
    expect(selectBuilderMode({ mode: 'nonsense' })).toBe('agent_mode'); // garbage fails SAFE
  });
});

// ── Behavior: cli_mode_routes_to_external_agent_driver_033_reused ─────────────────
describe('cli mode routing to 033 driver', () => {
  it('cli_mode_routes_to_external_agent_driver_033_reused', async () => {
    const producer = cliModeProducer('claude', stubDriver(STUB_EVENTS), () => IN_SET_DIFF);
    expect(producer.mode).toBe('cli_mode');
    const produced = await producer.produce(PACKET, SANDBOX);
    expect(produced.cli).toBe('claude');
    expect(produced.events).toHaveLength(2);               // consumed the driver's stream
    expect(produced.events.some(e => e.kind === 'completion')).toBe(true);
    expect(produced.diff).toBe(IN_SET_DIFF);
  });
});

// ── Behavior: both_modes_emit_diff_through_same_exit_gate_and_result_contract ─────
describe('both modes share the exit gate + result contract', () => {
  it('both_modes_emit_diff_through_same_exit_gate_and_result_contract', async () => {
    const agent = agentModeProducer(async (): Promise<ProducedDiff> => ({ diff: IN_SET_DIFF, events: [] }));
    const cli = cliModeProducer('claude', stubDriver(STUB_EVENTS), () => IN_SET_DIFF);

    const a = await runBuilderMode({ mode: 'agent_mode', producer: agent, packet: PACKET, sandbox: SANDBOX, contract: CONTRACT });
    const c = await runBuilderMode({ mode: 'cli_mode', producer: cli, packet: PACKET, sandbox: SANDBOX, contract: CONTRACT });

    // Same exit gate → same verdict for the same in-write-set diff.
    expect(a.verdict.accepted).toBe(true);
    expect(c.verdict.accepted).toBe(true);
    expect(a.verdict.changed_files).toEqual(['slugify.mjs']);
    expect(c.verdict.changed_files).toEqual(['slugify.mjs']);
    // Same result contract: self-report excluded regardless of mode.
    expect(a.verdict.self_report_excluded).toBe(true);
    expect(c.verdict.self_report_excluded).toBe(true);
    // Same orchestration decision contract.
    expect(a.decision.action).toBe('write_checkpoint');
    expect(c.decision.action).toBe('write_checkpoint');
  });

  it('shared exit gate rejects out-of-write-set in EITHER mode (whole-proposal reject → escalate)', async () => {
    const cli = cliModeProducer('claude', stubDriver(STUB_EVENTS), () => OUT_OF_SET_DIFF);
    const c = await runBuilderMode({ mode: 'cli_mode', producer: cli, packet: PACKET, sandbox: SANDBOX, contract: CONTRACT });
    expect(c.verdict.accepted).toBe(false);
    expect(c.verdict.rejected_whole).toBe(true);
    expect(c.verdict.out_of_write_set).toContain('secret.txt');
    expect(c.decision.action).toBe('escalate_human');
  });
});

// ── Behavior: agent_mode_unchanged_no_regression ─────────────────────────────────
describe('agent mode is additive', () => {
  it('agent_mode_unchanged_no_regression', async () => {
    const agent = agentModeProducer(async (): Promise<ProducedDiff> => ({ diff: IN_SET_DIFF, events: [] }));
    expect(agent.mode).toBe('agent_mode');
    const produced = await agent.produce(PACKET, SANDBOX);
    // agent_mode is not a CLI: no CLI label, no self-report — nothing about the existing
    // API+ACI path changed; cli_mode is layered alongside it.
    expect(produced.cli).toBeUndefined();
    const result = toDelegationResult('agent_mode', produced);
    expect(result.self_report_source).toBe('none');
    expect(result.diff).toBe(IN_SET_DIFF);
  });
});

// ── Behavior: mode_recorded_in_trace ─────────────────────────────────────────────
describe('mode recorded in trace', () => {
  it('mode_recorded_in_trace', async () => {
    const agent = agentModeProducer(async (): Promise<ProducedDiff> => ({ diff: IN_SET_DIFF, events: [] }));
    const cli = cliModeProducer('claude', stubDriver(STUB_EVENTS), () => IN_SET_DIFF);

    const a = await runBuilderMode({ mode: 'agent_mode', producer: agent, packet: PACKET, sandbox: SANDBOX, contract: CONTRACT });
    const c = await runBuilderMode({ mode: 'cli_mode', producer: cli, packet: PACKET, sandbox: SANDBOX, contract: CONTRACT });

    expect(a.trace.type).toBe('builder_mode');
    expect(a.trace.mode).toBe('agent_mode');
    expect(a.trace.story_id).toBe('S1');
    expect(a.trace.cli).toBeUndefined();
    expect(a.trace.accepted).toBe(true);

    expect(c.trace.type).toBe('builder_mode');
    expect(c.trace.mode).toBe('cli_mode');
    expect(c.trace.cli).toBe('claude');
    expect(c.trace.action).toBe('write_checkpoint');
  });
});
