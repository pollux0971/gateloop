import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DelegationTicker } from './DelegationTicker';
import type { AgentEvent } from '@gateloop/agent-delegate';

const stream: AgentEvent[] = [
  { cli: 'claude', kind: 'thinking', summary: 'planning the edit' },
  { cli: 'claude', kind: 'tool_call', tool: 'Edit', summary: 'tool: Edit' },
  { cli: 'claude', kind: 'completion', stop_reason: 'end_turn', summary: 'done', tokens: { input: 5, output: 2 } },
];

describe('delegation-ticker (STORY-033.7)', () => {
  // ── operator_can_observe_sandbox_activity ──
  it('renders sandbox AgentEvents so the operator can observe activity', () => {
    render(<DelegationTicker events={stream} cli="claude" />);
    const root = document.querySelector('[data-testid="delegation-ticker"]');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('data-cli')).toBe('claude');
    // one ReasoningEvent row per event
    expect(document.querySelectorAll('[data-testid^="reasoning-delegate-claude-"]')).toHaveLength(3);
    expect(screen.getByText(/sandbox agent activity/)).toBeTruthy();
  });

  // ── events_surface_in_thinking_ticker ──
  it('events surface in the thinking ticker (expandable)', () => {
    render(<DelegationTicker events={stream} cli="claude" />);
    expect(screen.getAllByText(/planning the edit/).length).toBeGreaterThan(0);
    // each row carries the external-agent role
    const row = document.querySelector('[data-testid="reasoning-delegate-claude-0"]');
    expect(row?.getAttribute('data-agent-role')).toBe('external:claude');
    // expandable like any v5 reasoning event
    fireEvent.click(screen.getAllByRole('button', { name: /thinking|expand/i })[0]);
    expect(document.querySelector('[data-expanded="true"]')).toBeTruthy();
  });

  // ── no_secret_in_trace (UI surface) ──
  it('no secret reaches the UI (redacted by the mapper)', () => {
    const leaky: AgentEvent[] = [{ cli: 'codex', kind: 'tool_call', tool: 'Bash', summary: 'use sk-ABCDEFGH12345678 now' }];
    render(<DelegationTicker events={leaky} cli="codex" />);
    expect(document.body.innerHTML).not.toContain('sk-ABCDEFGH12345678');
  });

  it('empty stream shows a placeholder', () => {
    render(<DelegationTicker events={[]} />);
    expect(screen.getByText(/no sandbox activity/)).toBeTruthy();
  });
});
