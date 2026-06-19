/**
 * STORY-033.10 (scriptable parts) — AcpDriver implements the SAME interface, feeds the
 * SAME result contract + gates, and is selectable in the registry. The real Gemini ACP
 * wire is GATED (no real transport here); a mock transport proves everything else.
 * CI-safe: mock transport, no CLI, no network, no key.
 */
import { describe, it, expect } from 'vitest';
import {
  AcpDriver, parseAcpMessage, selectDriver, collectEvents,
  buildDelegationResult, validateDelegationResult, runExitGate,
  HeadlessDriver,
  type AcpMessage, type AcpTransport, type AgentEvent,
  type DelegationTaskPacket, type SandboxHandle,
} from './index';

const PACKET: DelegationTaskPacket = { prompt: 'add a feature', allowed_write_set: ['core.mjs'] };
const SANDBOX: SandboxHandle = { cwd: '/tmp/sbx' };

/** A mock ACP transport: replays a scripted message sequence, then a clean exit. */
function mockTransport(messages: AcpMessage[], exitCode = 0): AcpTransport {
  return () => ({
    messages: (async function* () { for (const m of messages) yield m; })(),
    done: Promise.resolve(exitCode),
  });
}

const SCRIPT: AcpMessage[] = [
  { method: 'session/new', params: { model: 'gemini' } },
  { method: 'session/thought', params: { text: 'planning the change' } },
  { method: 'tool_call', params: { tool: 'edit_file' } },
  { method: 'fs/write_text_file', params: { path: 'core.mjs' } },
  { method: 'session/complete', params: { stop_reason: 'end_turn', tokens: { input: 100, output: 40 } } },
];

describe('033.10 — AcpDriver implements the same interface', () => {
  it('drives an ACP stream into the uniform AgentEvent shape', async () => {
    const driver = new AcpDriver({ transport: mockTransport(SCRIPT) });
    expect(driver.driver).toBe('acp');
    const events = await collectEvents(driver.run(PACKET, SANDBOX));
    expect(events.map(e => e.kind)).toEqual(['session', 'thinking', 'tool_call', 'diff', 'completion']);
    expect(events.find(e => e.kind === 'diff')!.path).toBe('core.mjs');
    const completion = events.find(e => e.kind === 'completion')!;
    expect(completion.stop_reason).toBe('end_turn');
    expect(completion.tokens).toEqual({ input: 100, output: 40 });
  });

  it('synthesizes a completion when the wire never sends one (same invariant as headless)', async () => {
    const driver = new AcpDriver({ transport: mockTransport([{ method: 'session/thought', params: { text: 'x' } }], 0) });
    const events = await collectEvents(driver.run(PACKET, SANDBOX));
    const completion = events.filter(e => e.kind === 'completion');
    expect(completion).toHaveLength(1);
    expect(completion[0].raw?.synthesized).toBe(true);
  });

  it('keeps an unknown method as kind=unknown (never silently dropped)', () => {
    expect(parseAcpMessage('gemini', { method: 'some/future/method' }).kind).toBe('unknown');
  });
});

describe('033.10 — same result contract + gates reused', () => {
  it('AcpDriver events feed buildDelegationResult with driver=acp (diff authoritative)', async () => {
    const driver = new AcpDriver({ transport: mockTransport(SCRIPT) });
    const events = await collectEvents(driver.run(PACKET, SANDBOX));
    const result = buildDelegationResult({
      cli: 'gemini', driver: 'acp',
      diff: 'diff --git a/core.mjs b/core.mjs\n+export function f(){}\n',
      events,
    });
    expect(result.driver).toBe('acp');
    expect(result.tokens).toEqual({ input: 100, output: 40 });
    expect(result.stop_reason).toBe('end_turn');
    expect(validateDelegationResult(result).ok).toBe(true);   // same validation as headless
  });

  it('the exit gate consumes an acp result the same way (write-set enforced on the diff)', async () => {
    const driver = new AcpDriver({ transport: mockTransport(SCRIPT) });
    const events = await collectEvents(driver.run(PACKET, SANDBOX));
    const result = buildDelegationResult({
      cli: 'gemini', driver: 'acp',
      diff: 'diff --git a/core.mjs b/core.mjs\n+export function f(){}\n',
      events,
    });
    // In-set acp diff: the write-set crux (the security stage) passes on the diff.
    const gate = await runExitGate(
      result,
      { story_id: 'S1', allowed_write_set: ['core.mjs'] },
      { validator: () => ({ ok: true, errors: [] }) },
    );
    expect(gate.changed_files).toEqual(['core.mjs']);                 // from the AUTHORITATIVE diff
    expect(gate.out_of_write_set).toEqual([]);
    expect(gate.rejected_whole).toBe(false);
    expect(gate.stages.find(s => s.stage === 'write_set')!.ok).toBe(true);
    expect(gate.self_report_excluded).toBe(true);                    // self-report never trusted

    // Out-of-set acp diff: the same gate rejects the WHOLE proposal (zero exceptions).
    const evil = buildDelegationResult({
      cli: 'gemini', driver: 'acp',
      diff: 'diff --git a/secrets.txt b/secrets.txt\n+leak\n',
      events,
    });
    const evilGate = await runExitGate(evil, { story_id: 'S1', allowed_write_set: ['core.mjs'] });
    expect(evilGate.rejected_whole).toBe(true);
    expect(evilGate.accepted).toBe(false);
  });
});

describe('033.10 — driver is selectable in the registry', () => {
  it('selectDriver returns an AcpDriver for kind=acp with an injected transport', () => {
    const d = selectDriver('acp', { transport: mockTransport(SCRIPT) });
    expect(d.driver).toBe('acp');
    expect(d).toBeInstanceOf(AcpDriver);
  });

  it('selectDriver returns a HeadlessDriver for kind=headless', () => {
    const d = selectDriver('headless', { cli: 'claude' });
    expect(d.driver).toBe('headless');
    expect(d).toBeInstanceOf(HeadlessDriver);
  });

  it('GATED: choosing acp WITHOUT a transport throws (the real ACP wire is gated)', () => {
    expect(() => selectDriver('acp', {})).toThrow(/acp driver requires a transport.*gated/);
  });
});
