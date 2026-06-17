import { describe, it, expect } from 'vitest';
import { mapAgentEventToTrace, agentEventToTicker, agentEventsToTicker } from './agentTrace';
import type { AgentEvent } from './headlessDriver';

const ev = (over: Partial<AgentEvent>): AgentEvent => ({ cli: 'claude', kind: 'message', summary: 's', ...over });

describe('agent-delegate / agent event → trace + ticker (STORY-033.7)', () => {
  // ── agent_events_mapped_to_trace ──
  it('agent_events_mapped_to_trace', () => {
    const t = mapAgentEventToTrace(ev({ kind: 'tool_call', tool: 'Edit', summary: 'tool: Edit' }));
    expect(t.type).toBe('delegate_tool_call');
    expect(t.agent_role).toBe('external:claude');
    expect(t.summary).toBe('tool: Edit');
    expect(t.payload).toMatchObject({ cli: 'claude', kind: 'tool_call', tool: 'Edit' });

    const c = mapAgentEventToTrace(ev({ kind: 'completion', stop_reason: 'end_turn', tokens: { input: 9, output: 3 }, summary: 'completed' }));
    expect(c.type).toBe('delegate_completion');
    expect(c.payload).toMatchObject({ stop_reason: 'end_turn', tokens: { input: 9, output: 3 } });
  });

  it('the raw CLI object is never placed in the trace payload', () => {
    const t = mapAgentEventToTrace(ev({ kind: 'message', summary: 'hi', raw: { secret_field: 'sk-ABCDEFGH12345678' } }));
    expect(JSON.stringify(t)).not.toContain('raw');
    expect(JSON.stringify(t)).not.toContain('secret_field');
  });

  // ── no_secret_in_trace ──
  it('no_secret_in_trace: secret-looking strings are redacted in summary + payload', () => {
    const leaky = ev({ kind: 'tool_call', tool: 'Bash', summary: 'export ANTHROPIC_API_KEY=sk-ABCDEFGH12345678 && run', path: 'ghp_ABCDEFGH12345678' });
    const t = mapAgentEventToTrace(leaky);
    const blob = JSON.stringify(t);
    expect(blob).not.toContain('sk-ABCDEFGH12345678');
    expect(blob).not.toContain('ghp_ABCDEFGH12345678');
    expect(blob).toContain('«redacted»');
  });

  // ── events_surface_in_thinking_ticker ──
  it('events_surface_in_thinking_ticker', () => {
    const item = agentEventToTicker(ev({ kind: 'thinking', summary: 'reasoning about the diff' }), 2);
    expect(item.eventId).toBe('delegate-claude-2');
    expect(item.agentRole).toBe('external:claude');
    expect(item.kind).toBe('thinking');
    expect(item.preview).toContain('reasoning about the diff');
    expect(item.fullText).toContain('kind: thinking');
  });

  it('ticker text is redacted too', () => {
    const item = agentEventToTicker(ev({ kind: 'tool_call', tool: 'Bash', summary: 'key sk-ABCDEFGH12345678' }), 0);
    expect(item.preview).not.toContain('sk-ABCDEFGH12345678');
    expect(item.fullText).not.toContain('sk-ABCDEFGH12345678');
  });

  // ── operator_can_observe_sandbox_activity ──
  it('operator_can_observe_sandbox_activity: a whole stream maps to ordered ticker items', () => {
    const stream: AgentEvent[] = [
      ev({ kind: 'session', summary: 'init' }),
      ev({ kind: 'thinking', summary: 'planning' }),
      ev({ kind: 'tool_call', tool: 'Edit', summary: 'tool: Edit' }),
      ev({ kind: 'completion', stop_reason: 'end_turn', summary: 'done' }),
    ];
    const items = agentEventsToTicker(stream);
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.kind)).toEqual(['session', 'thinking', 'tool_call', 'completion']);
    // each carries the external-agent role so the operator sees it is sandbox activity
    expect(items.every((i) => i.agentRole === 'external:claude')).toBe(true);
    // ids are unique + ordered
    expect(new Set(items.map((i) => i.eventId)).size).toBe(4);
  });
});
