import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkillsPage, type SkillEntry, type SkillDetail } from './SkillsPage';

const skills: SkillEntry[] = [
  { skill_id: 'developer.patch-proposal', agent_role: 'developer', description: 'Propose a patch', status: 'registered', test_count: 5 },
  { skill_id: 'debugger.failure-triage', agent_role: 'debugger', description: 'Triage failures', status: 'quarantined', quarantine_reason: 'stub only' },
];

describe('skills-page', () => {
  it('catalog_grouped_by_role', () => {
    render(<SkillsPage skills={skills} />);
    expect(screen.getByText(/developer/i)).toBeTruthy();
    expect(screen.getByText(/debugger/i)).toBeTruthy();
  });

  it('gate_status_and_avoid_visible', () => {
    render(<SkillsPage skills={skills} />);
    expect(screen.getByText('registered')).toBeTruthy();
    expect(screen.getByText('quarantined')).toBeTruthy();
    expect(screen.getByText(/stub only/i)).toBeTruthy();
  });

  it('tool_allowlist_rendered_per_role', () => {
    const allowlist = [{ role: 'developer', allowed_tools: ['read_file', 'apply_patch'] }];
    render(<SkillsPage skills={[skills[0]]} toolAllowlist={allowlist} />);
    expect(screen.getByText('apply_patch')).toBeTruthy();
  });

  it('ui_cannot_register_skills', () => {
    render(<SkillsPage skills={skills} />);
    expect(document.querySelector('[data-testid="skills-page-read-only"]')).toBeTruthy();
    const btns = screen.queryAllByRole('button', { name: /register/i });
    expect(btns.length).toBe(0);
  });
});

// ── STORY-032.5: skill expands to metadata / markdown / scripts tabs ───────────

const DETAIL: SkillDetail = {
  id: 'developer.rest-api-template',
  metadata: { skill_id: 'developer.rest-api-template', status: 'registered', version: '0.1.0' },
  skill_md: '# REST API Template\nScaffold a typed REST API.',
  scripts: [{ name: 'evaluate.py', source: 'def evaluate():\n    return True' }],
  static_config_level: true,
};

describe('STORY-032.5 skill contents tabs', () => {
  const withDetail: SkillEntry = {
    skill_id: 'developer.rest-api-template', agent_role: 'developer',
    description: 'Scaffold a REST API', status: 'registered', detail: DETAIL,
  };

  it('skill_expands_to_metadata_markdown_scripts', () => {
    render(<SkillsPage skills={[withDetail]} />);
    fireEvent.click(screen.getByTestId('skill-contents-toggle'));
    // metadata tab is default
    expect(screen.getByTestId('tab-metadata').textContent).toContain('rest-api-template');
    // switch to markdown
    fireEvent.click(screen.getByRole('button', { name: 'SKILL.md' }));
    expect(screen.getByTestId('tab-markdown').textContent).toContain('REST API Template');
    // switch to scripts — source shown
    fireEvent.click(screen.getByRole('button', { name: /scripts/i }));
    expect(screen.getByTestId('tab-scripts').textContent).toContain('evaluate.py');
    expect(screen.getByTestId('tab-scripts').textContent).toContain('def evaluate');
  });

  it('reads_from_introspection_endpoints / ui_states_static', () => {
    render(<SkillsPage skills={[withDetail]} />);
    fireEvent.click(screen.getByTestId('skill-contents-toggle'));
    expect(document.querySelector('[data-source="GET /skills/{id}"]')).toBeTruthy();
    expect(screen.getByText(/contents \(static\)/i)).toBeTruthy();
  });
});
