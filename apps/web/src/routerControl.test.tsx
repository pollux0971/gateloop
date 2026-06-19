/**
 * WORK D (frontend) — the router control is PLAIN LANGUAGE: a Save-money↔Reliable
 * selector + on/off, and choice explanations, with NO math terms (P(success), λ,
 * score, formula) ever shown to the operator.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RouterControl, routerChoicePhrase } from './ApiPage';

describe('WORK D — RouterControl is plain language', () => {
  it('shows Save money / Balanced / Reliable and an on/off toggle (no λ/formula)', () => {
    const { container } = render(<RouterControl enabled mode="balanced" />);
    expect(screen.getByText('Save money')).toBeTruthy();
    expect(screen.getByText('Reliable')).toBeTruthy();
    expect(screen.getByTestId('router-enabled')).toBeTruthy();
    const text = container.textContent ?? '';
    for (const term of ['λ', 'lambda', 'P(success)', 'score', 'formula', 'cost(']) {
      expect(text).not.toContain(term);
    }
  });

  it('toggling and mode change fire onChange', () => {
    const onChange = vi.fn();
    render(<RouterControl enabled mode="balanced" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('router-mode-save-money'));
    expect(onChange).toHaveBeenCalledWith({ mode: 'save-money' });
    fireEvent.click(screen.getByTestId('router-enabled'));
    expect(onChange).toHaveBeenCalledWith({ enabled: false });
  });
});

describe('WORK D — routerChoicePhrase is plain language', () => {
  it('explains a choice without any math', () => {
    const p = routerChoicePhrase('S2', 'deepseek-v4-flash', 'trivial');
    expect(p).toMatch(/S2 is a simpler task → handled by deepseek-v4-flash/);
    for (const term of ['λ', 'P(success)', 'score', 'cost']) expect(p).not.toContain(term);
  });
});
