import { describe, it, expect } from 'vitest';
import type { AgentEvent, DelegationTaskPacket, SandboxHandle } from '@gateloop/agent-delegate';
import { ProviderDriver, type ProviderToolMediator, type ToolMediation } from './providerDriver';
import { createScriptedEngine, scriptedToolRun } from './scriptedEngine';

const PACKET: DelegationTaskPacket = { prompt: 'create slugify.mjs', allowed_write_set: ['slugify.mjs'] };
const SANDBOX: SandboxHandle = { cwd: '/tmp/sandbox-copy' };

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('STORY-035.2: ProviderDriver drives a backend in-process (scripted, zero spend)', () => {
  it('yields session → mapped events → completion from the engine stream', async () => {
    const engine = createScriptedEngine({
      backendId: 'openai',
      model: 'gpt-5.4',
      parts: scriptedToolRun('apply_patch', { path: 'slugify.mjs' }, { ok: true }),
    });
    const driver = new ProviderDriver({ engine });
    expect(driver.driver).toBe('provider');
    expect(driver.backendId).toBe('openai');

    const evs = await collect(driver.run(PACKET, SANDBOX));
    expect(evs[0].kind).toBe('session');
    expect(evs[0].summary).toContain('openai/gpt-5.4');
    expect(evs.map((e) => e.kind)).toContain('tool_call');
    expect(evs.map((e) => e.kind)).toContain('tool_result');
    expect(evs.at(-1)!.kind).toBe('completion');
    expect(evs.at(-1)!.tokens).toEqual({ input: 10, output: 5 });
  });

  it('forwards the packet prompt + tool surface + signal to the engine', async () => {
    let seen: { prompt: string; tools?: { name: string }[]; signal?: AbortSignal } | undefined;
    const engine = createScriptedEngine({
      parts: [{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      onRun: (input) => { seen = { prompt: input.prompt, tools: input.tools, signal: input.signal }; },
    });
    const mediator: ProviderToolMediator = { tools: () => [{ name: 'apply_patch' }], mediate: () => ({ allowed: true, output: {} }) };
    const ac = new AbortController();
    const driver = new ProviderDriver({ engine, toolMediator: mediator });
    await collect(driver.run(PACKET, { ...SANDBOX, signal: ac.signal }));
    expect(seen!.prompt).toBe('create slugify.mjs');
    expect(seen!.tools).toEqual([{ name: 'apply_patch' }]);
    expect(seen!.signal).toBe(ac.signal);
  });

  it('mediates tool calls through the injected mediator — ALLOW emits a tool_result', async () => {
    let mediated = 0;
    const mediator: ProviderToolMediator = {
      tools: () => [{ name: 'apply_patch' }],
      mediate: (call): ToolMediation => { mediated++; return { allowed: true, output: { applied: call.toolName } }; },
    };
    // Engine yields ONLY the tool-call; the harness (mediator) produces the result.
    const engine = createScriptedEngine({
      parts: [
        { type: 'tool-call', toolCallId: 't1', toolName: 'apply_patch', input: { path: 'slugify.mjs' } },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } },
      ],
    });
    const evs = await collect(new ProviderDriver({ engine, toolMediator: mediator }).run(PACKET, SANDBOX));
    expect(mediated).toBe(1);
    const result = evs.find((e) => e.kind === 'tool_result');
    expect(result).toBeDefined();
    expect(result!.summary).toContain('apply_patch');
  });

  it('mediator DENY stops the call (035.3 permission-gateway hook) — emits a denial, no result', async () => {
    const mediator: ProviderToolMediator = {
      tools: () => [{ name: 'apply_patch' }],
      mediate: () => ({ allowed: false, reason: 'not in write-set' }),
    };
    const engine = createScriptedEngine({
      parts: [
        { type: 'tool-call', toolCallId: 't1', toolName: 'Bash', input: { command: 'rm -rf /' } },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    });
    const evs = await collect(new ProviderDriver({ engine, toolMediator: mediator }).run(PACKET, SANDBOX));
    const denied = evs.find((e) => (e.raw as { denied?: boolean })?.denied);
    expect(denied).toBeDefined();
    expect(denied!.summary).toContain('tool_denied');
  });

  it('skips an engine-supplied tool-result when the harness already mediated that call', async () => {
    const mediator: ProviderToolMediator = { tools: () => [], mediate: () => ({ allowed: true, output: { ok: true } }) };
    const engine = createScriptedEngine({
      parts: [
        { type: 'tool-call', toolCallId: 't1', toolName: 'read', input: {} },
        { type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { sneaky: true } }, // must be skipped
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    });
    const evs = await collect(new ProviderDriver({ engine, toolMediator: mediator }).run(PACKET, SANDBOX));
    const results = evs.filter((e) => e.kind === 'tool_result');
    expect(results).toHaveLength(1); // only the harness-produced one, not the engine's
    expect(JSON.stringify(results[0].raw)).not.toContain('sneaky');
  });

  it('applies the redactor to every event summary', async () => {
    const engine = createScriptedEngine({ parts: [{ type: 'text-delta', text: 'key=SECRET' }, { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }] });
    const evs = await collect(new ProviderDriver({ engine, redact: (s) => s.split('SECRET').join('[X]') }).run(PACKET, SANDBOX));
    expect(evs.find((e) => e.kind === 'message')!.summary).toBe('key=[X]');
  });
});
