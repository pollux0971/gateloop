import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentPromptView, type AgentPromptData } from './AgentPromptView';

const views: AgentPromptData[] = [
  {
    role: 'developer',
    base: 'You are the Developer.',
    mounted_skills: [{ name: 'rest-api-template' }],
    envelope_docs: '### Envelope: DeveloperTaskPacket',
    composed: 'You are the Developer.\n\n## Mounted skills\n- rest-api-template\n\n## Envelopes you receive\n### Envelope: DeveloperTaskPacket',
    static_config_level: true,
  },
];

describe('STORY-032.5 agent prompt view', () => {
  it('agent_full_prompt_viewable', () => {
    render(<AgentPromptView views={views} />);
    // expand the agent card and read the full composed prompt
    fireEvent.click(screen.getByRole('button', { name: /developer/i }));
    const pre = screen.getByTestId('composed-developer');
    expect(pre.textContent).toContain('You are the Developer.');
    expect(pre.textContent).toContain('## Mounted skills');
    expect(pre.textContent).toContain('## Envelopes you receive');
  });

  it('reads_from_introspection_endpoints', () => {
    render(<AgentPromptView views={views} />);
    expect(document.querySelector('[data-source="GET /agents/{role}/prompt"]')).toBeTruthy();
  });

  it('ui_states_these_are_static_not_runtime', () => {
    render(<AgentPromptView views={views} />);
    expect(screen.getAllByTestId('static-not-runtime').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not a runtime/i).length).toBeGreaterThan(0);
  });
});
