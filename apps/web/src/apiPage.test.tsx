import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TierHistory, ShadowEvalPanel, EnablementWizard, ModelRegistryTable, type ModelRow, type AgentRoutingRow } from './ApiPage';

describe('api-page', () => {
  it('per_attempt_tier_and_reason_visible', () => {
    const entries = [
      { attempt: 1, tier: 'cheap' as const, escalation_reason: null },
      { attempt: 2, tier: 'strong' as const, escalation_reason: 'gene_match' as const },
    ];
    render(<TierHistory entries={entries} />);
    expect(screen.getByText('cheap')).toBeTruthy();
    expect(screen.getByText('strong')).toBeTruthy();
    expect(screen.getByText(/gene_match/)).toBeTruthy();
  });

  it('shadow_eval_results_rendered', () => {
    const results = [
      { model_ref: 'test/model-v1', pass_rate: 1.0, status_after: 'active' as const },
      { model_ref: 'test/model-v2', pass_rate: 0.5, status_after: 'candidate' as const },
    ];
    render(<ShadowEvalPanel results={results} />);
    expect(screen.getByText('test/model-v1')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('candidate')).toBeTruthy();
  });

  it('enablement_wizard_guides_but_cannot_flip', () => {
    render(<EnablementWizard
      steps={['Step 1: Read runbook', 'Step 2: Set env var', 'Step 3: Confirm in policy.yaml']}
      currentStep={1}
      gateCurrentlyEnabled={false}
    />);
    expect(document.querySelector('[data-testid="enablement-wizard-guide-only"]')).toBeTruthy();
    // No button that says "enable" or "flip"
    expect(screen.queryAllByRole('button', { name: /enable now|flip gate/i }).length).toBe(0);
    // Steps are visible
    expect(screen.getByText(/Step 1/)).toBeTruthy();
  });
});

// ── STORY-032.7: model registry table + add form + CLI tools ──────────────────

const MODELS: ModelRow[] = [
  { name: 'gpt-5.4-mini', kind: 'openai', base_url: 'https://api.openai.com/v1', pricing: { input: 0.75, output: 4.5 } },
  { name: 'codex-subscription', kind: 'openai_responses_codex', base_url: 'https://chatgpt.com/backend-api/codex/responses' },
  { name: 'codex-cli', kind: 'cli', cli: { driver: 'headless', command: 'codex exec' } },
];
const ROUTING: AgentRoutingRow[] = [
  { agent: 'developer', model: 'gpt-5.4-mini' },
  { agent: 'reviewer', model: 'gpt-5.4-mini' },
];

describe('STORY-032.7 model registry table', () => {
  it('model_table_with_add_form', () => {
    const onAddModel = vi.fn();
    render(<ModelRegistryTable models={MODELS} routing={ROUTING} onAddModel={onAddModel} />);
    // table lists the registered (non-cli) models with properties (cli excluded)
    expect(document.querySelector('[data-model-name="gpt-5.4-mini"]')).toBeTruthy();
    expect(document.querySelector('[data-model-name="codex-cli"]')).toBeNull();
    expect(screen.getByText('0.75/4.5')).toBeTruthy();           // pricing
    expect(screen.getByText('unknown')).toBeTruthy();            // codex-subscription has no pricing
    // add-model form: fill name + price, submit
    expect(screen.getByTestId('add-model-form')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('model name'), { target: { value: 'my-cheap-coder' } });
    fireEvent.change(screen.getByLabelText('price input'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'add model' }));
    expect(onAddModel).toHaveBeenCalledWith(expect.objectContaining({
      name: 'my-cheap-coder', kind: 'openai', base_url: 'https://api.openai.com/v1', pricing: { input: 0.5 },
    }));
  });

  it('agent_dropdown_uses_model_names', () => {
    render(<ModelRegistryTable models={MODELS} routing={ROUTING} />);
    const select = screen.getByLabelText('route developer') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map(o => o.value);
    // options are the self-chosen model names (non-cli), not provider/model strings
    expect(optionValues).toEqual(['gpt-5.4-mini', 'codex-subscription']);
    expect(optionValues.every(v => !v.includes('/'))).toBe(true);
  });

  it('cli_tools_register_below_divider', () => {
    const onAddCli = vi.fn();
    render(<ModelRegistryTable models={MODELS} routing={ROUTING} onAddCli={onAddCli} />);
    // a divider separates the CLI section on the same page
    const divider = screen.getByTestId('cli-divider');
    const cliSection = screen.getByTestId('cli-tools-section');
    expect(divider).toBeTruthy();
    // the CLI section comes AFTER the divider in document order
    expect(divider.compareDocumentPosition(cliSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // existing cli tool listed; add-cli form has a driver selector
    expect(within(cliSection).getByText('codex-cli')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('cli name'), { target: { value: 'gemini-cli' } });
    fireEvent.change(screen.getByLabelText('cli driver'), { target: { value: 'acp' } });
    fireEvent.change(screen.getByLabelText('cli command'), { target: { value: 'gemini' } });
    fireEvent.click(screen.getByRole('button', { name: 'add CLI tool' }));
    expect(onAddCli).toHaveBeenCalledWith(expect.objectContaining({
      name: 'gemini-cli', kind: 'cli', cli: { driver: 'acp', command: 'gemini' },
    }));
  });
});
