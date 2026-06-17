import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelRegistryTable, type ModelRow, type AgentRoutingRow } from './ApiPage';

const MODELS: ModelRow[] = [
  { name: 'deepseek-v4-pro', kind: 'openai', base_url: 'https://api.deepseek.com' },
  { name: 'claude-code-cli', kind: 'cli', cli: { driver: 'headless', command: 'claude', args: ['--print', '--bare'] } },
  { name: 'gemini-cli', kind: 'cli', cli: { driver: 'acp', command: 'gemini' } },
];
const ROUTING: AgentRoutingRow[] = [{ agent: 'developer', model: 'deepseek-v4-pro' }];

describe('STORY-033.8: CLI tools in the model registry frontend', () => {
  // ── frontend_shows_cli_below_divider_with_driver_selector ──
  it('frontend_shows_cli_below_divider_with_driver_selector', () => {
    render(<ModelRegistryTable models={MODELS} routing={ROUTING} />);

    // there is a divider, and the CLI section sits below it
    expect(document.querySelector('[data-testid="cli-divider"]')).toBeTruthy();
    const section = document.querySelector('[data-testid="cli-tools-section"]');
    expect(section).toBeTruthy();

    // CLI tools are listed in the CLI section (below the divider), not the models table
    expect(document.querySelector('[data-cli-name="claude-code-cli"]')).toBeTruthy();
    expect(document.querySelector('[data-model-name="claude-code-cli"]')).toBeNull();

    // the add-CLI form has a driver selector offering headless + acp
    const driverSelect = screen.getByLabelText('cli driver') as HTMLSelectElement;
    const options = Array.from(driverSelect.options).map((o) => o.value);
    expect(options).toEqual(['headless', 'acp']);

    // the listed headless tool shows its driver + derived auth env
    const row = document.querySelector('[data-cli-name="claude-code-cli"]')!;
    expect(row.getAttribute('data-cli-driver')).toBe('headless');
    expect(row.querySelector('[data-cli-auth-env="ANTHROPIC_API_KEY"]')).toBeTruthy();
  });

  // ── command_instead_of_base_url ──
  it('command_instead_of_base_url: the CLI form takes command + args, never a base_url', () => {
    const onAddCli = vi.fn();
    render(<ModelRegistryTable models={MODELS} routing={ROUTING} onAddCli={onAddCli} />);

    // the CLI form exposes command + args inputs, and NO base-url input
    expect(screen.getByLabelText('cli command')).toBeTruthy();
    expect(screen.getByLabelText('cli args')).toBeTruthy();
    // (base url mode/input belongs to the API-model form, not the CLI form)

    fireEvent.change(screen.getByLabelText('cli name'), { target: { value: 'codex-cli' } });
    fireEvent.change(screen.getByLabelText('cli command'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('cli args'), { target: { value: 'exec --json --ephemeral' } });
    fireEvent.click(screen.getByRole('button', { name: /add CLI tool/i }));

    expect(onAddCli).toHaveBeenCalledTimes(1);
    const payload = onAddCli.mock.calls[0][0] as ModelRow;
    expect(payload.kind).toBe('cli');
    expect(payload.base_url).toBeUndefined();              // never a base_url
    expect(payload.cli?.command).toBe('codex');
    expect(payload.cli?.args).toEqual(['exec', '--json', '--ephemeral']);
    expect(payload.cli?.driver).toBe('headless');
  });
});
