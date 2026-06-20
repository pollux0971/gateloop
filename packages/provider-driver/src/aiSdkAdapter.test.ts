import { describe, it, expect } from 'vitest';
import { mapEnginePartToAgentEvent, backendToCliKind } from './aiSdkAdapter';
import { normalizeAiSdkPart } from './aiSdkEngine';
import type { EngineStreamPart } from './engine';

describe('STORY-035.2: aiSdkAdapter — engine parts → AgentEvent (one shape, no SDK leak)', () => {
  it('maps each neutral part kind to the inherited AgentEvent kinds', () => {
    const parts: EngineStreamPart[] = [
      { type: 'reasoning-delta', text: 'thinking…' },
      { type: 'text-delta', text: 'hello' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'apply_patch', input: { path: 'a.ts' } },
      { type: 'tool-result', toolCallId: 't1', toolName: 'apply_patch', output: { ok: true } },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 3 } },
    ];
    const evs = parts.map((p) => mapEnginePartToAgentEvent('openai', p));
    expect(evs.map((e) => e!.kind)).toEqual(['thinking', 'message', 'tool_call', 'tool_result', 'completion']);
    expect(evs[2]!.tool).toBe('apply_patch');
    expect(evs[4]!.stop_reason).toBe('end_turn');
    expect(evs[4]!.tokens).toEqual({ input: 7, output: 3 });
    // backend id preserved for fidelity even though cli is the nearest CliKind
    expect(evs[0]!.cli).toBe('codex');
    expect((evs[0]!.raw as { backendId: string }).backendId).toBe('openai');
  });

  it('maps backend id → nearest inherited CliKind', () => {
    expect(backendToCliKind('anthropic')).toBe('claude');
    expect(backendToCliKind('openai')).toBe('codex');
    expect(backendToCliKind('google')).toBe('gemini');
    expect(backendToCliKind('whatever')).toBe('codex');
  });

  it('applies the redactor to summaries (a resolved key must never reach a trace)', () => {
    const redact = (s: string) => s.split('SECRET-KEY').join('[REDACTED]');
    const ev = mapEnginePartToAgentEvent('openai', { type: 'text-delta', text: 'leak SECRET-KEY here' }, redact);
    expect(ev!.summary).toBe('leak [REDACTED] here');
  });

  it('normalizeAiSdkPart bridges v4/v5 SDK naming (textDelta/args vs text/input) without importing the SDK', () => {
    expect(normalizeAiSdkPart({ type: 'text-delta', textDelta: 'v4' })).toEqual({ type: 'text-delta', text: 'v4' });
    expect(normalizeAiSdkPart({ type: 'text-delta', text: 'v5' })).toEqual({ type: 'text-delta', text: 'v5' });
    expect(normalizeAiSdkPart({ type: 'tool-call', toolCallId: 'x', toolName: 'read', args: { a: 1 } }))
      .toEqual({ type: 'tool-call', toolCallId: 'x', toolName: 'read', input: { a: 1 } });
    expect(normalizeAiSdkPart({ type: 'finish', finishReason: 'stop', usage: { promptTokens: 4, completionTokens: 2 } }))
      .toEqual({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2 } });
    expect(normalizeAiSdkPart({ type: 'step-start' })).toBeNull();
  });
});
