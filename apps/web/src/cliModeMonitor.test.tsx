import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CliModeMonitorView, type CliModeTrace } from './CliModeMonitor';
// Render against the REAL captured 034.5 trace fixture (not a guessed shape).
import realTrace from '../../api/fixtures/cli-mode-trace.json';

const trace = realTrace as unknown as CliModeTrace;

describe('STORY-034.6: CLI-mode monitor — read-only projection of the real 034.5 run', () => {
  it('shows the two-layer defense: Layer 2 (4 invariants, all green) + Layer 1 status', () => {
    render(<CliModeMonitorView trace={trace} />);
    expect(screen.getByTestId('layer2-status')).toBeTruthy();
    expect(screen.getByTestId('layer1-status')).toBeTruthy();
    expect(screen.getAllByTestId('layer2-invariant')).toHaveLength(4);
    // plain-language, not raw snake_case
    expect(screen.getByTestId('layer2-status').textContent).toMatch(/the cage cannot read any host secret/);
    // the honest 034.5 finding is surfaced
    expect(screen.getByTestId('layer1-honest-note').textContent).toMatch(/reached the API directly|through the proxy/);
  });

  it('shows the real bash command stream (one Write to /work) and the escape review (no attempts)', () => {
    render(<CliModeMonitorView trace={trace} />);
    const cmds = screen.getAllByTestId('bash-command');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].textContent).toMatch(/Write/);
    expect(cmds[0].textContent).toMatch(/confined to \/work/);
    const escapes = screen.getAllByTestId('escape-item');
    expect(escapes.length).toBeGreaterThanOrEqual(3);
    escapes.forEach(e => expect(e.textContent).toMatch(/no attempt to/));
  });

  it('shows the completion flow + exit-gate ACCEPTED verdict', () => {
    render(<CliModeMonitorView trace={trace} />);
    expect(screen.getAllByTestId('completion-step')).toHaveLength(5);
    expect(screen.getByTestId('exit-gate-verdict').textContent).toMatch(/ACCEPTED/);
    expect(screen.getByTestId('diff-panel').textContent).toMatch(/slugify\.mjs/);
  });

  it('is READ-ONLY — the only control replays the recorded trace; no run/spawn/execute control', () => {
    const { container } = render(<CliModeMonitorView trace={trace} />);
    // replay steps through existing events (read-only projection)
    const replay = screen.getByTestId('replay-step');
    fireEvent.click(replay);
    expect(screen.getAllByTestId('replay-event').length).toBeGreaterThan(0);
    // no control that could trigger execution or relax isolation
    expect(container.textContent || '').not.toMatch(/\b(spawn|execute run|start run|disable isolation|open gate)\b/i);
  });
});
