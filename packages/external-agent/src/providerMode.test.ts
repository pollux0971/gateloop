import { describe, it, expect } from 'vitest';
import type { AgentEvent, DelegationTaskPacket, SandboxHandle, ExitGateContract } from '@gateloop/agent-delegate';
import { providerModeProducer, runBuilderMode, type ProviderRunnerLike } from './index';

// An inline fake provider runner (no provider-driver dependency, no real spend): emits the
// driver-shaped AgentEvent stream the producer consumes.
function fakeRunner(events: AgentEvent[]): ProviderRunnerLike {
  return {
    async *run(_p: DelegationTaskPacket, _s: SandboxHandle) {
      for (const e of events) yield e;
    },
  };
}

const PACKET: DelegationTaskPacket = { prompt: 'build slugify', allowed_write_set: ['slugify.mjs'] };
const SANDBOX: SandboxHandle = { cwd: '/tmp/sandbox-copy' };
const CONTRACT: ExitGateContract = {
  story_id: 'S1',
  allowed_write_set: ['slugify.mjs'],
  acceptance_criteria: { behaviors_must_pass: ['slugify_lowercases_and_hyphenates_words'] },
};

const IN_SET_DIFF = [
  'diff --git a/slugify.mjs b/slugify.mjs',
  '+++ b/slugify.mjs',
  '+export function slugify(s){return s.toLowerCase();}',
].join('\n');
const OUT_OF_SET_DIFF = [
  'diff --git a/secret.txt b/secret.txt',
  '+++ b/secret.txt',
  '+leak',
].join('\n');

const EVENTS: AgentEvent[] = [
  { cli: 'codex', kind: 'session', summary: 'session:openai/gpt-5.4' },
  { cli: 'codex', kind: 'tool_call', tool: 'apply_patch', summary: 'tool_call:apply_patch' },
  { cli: 'codex', kind: 'completion', summary: 'completion:stop', stop_reason: 'end_turn', tokens: { input: 5, output: 2 } },
];

describe('STORY-035.2: provider_mode producer flows through the INHERITED exit gate (diff authoritative)', () => {
  it('produces the authoritative diff from the driver stream', async () => {
    const producer = providerModeProducer(fakeRunner(EVENTS), () => IN_SET_DIFF);
    const produced = await producer.produce(PACKET, SANDBOX);
    expect(produced.diff).toBe(IN_SET_DIFF);
    expect(produced.events).toHaveLength(3);
    expect(producer.mode).toBe('provider_mode'); // its own lane (renamed from cli_mode in TIER C)
  });

  it('an in-write-set diff is ACCEPTED by the unchanged exit gate', async () => {
    const res = await runBuilderMode({
      mode: 'provider_mode',
      producer: providerModeProducer(fakeRunner(EVENTS), () => IN_SET_DIFF),
      packet: PACKET,
      sandbox: SANDBOX,
      contract: CONTRACT,
    });
    expect(res.verdict.accepted).toBe(true);
    expect(res.verdict.out_of_write_set).toEqual([]);
    expect(res.verdict.changed_files).toEqual(['slugify.mjs']);
  });

  it('an out-of-write-set diff is REJECT_WHOLE (the crux still bites, unchanged)', async () => {
    const res = await runBuilderMode({
      mode: 'provider_mode',
      producer: providerModeProducer(fakeRunner(EVENTS), () => OUT_OF_SET_DIFF),
      packet: PACKET,
      sandbox: SANDBOX,
      contract: CONTRACT,
    });
    expect(res.verdict.accepted).toBe(false);
    expect(res.verdict.rejected_whole).toBe(true);
    expect(res.verdict.out_of_write_set).toContain('secret.txt');
  });
});
