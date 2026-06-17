/**
 * STORY — Wire DEVELOPER_PREFLIGHT into the state machine.
 *
 * The Developer's pre-submit Observe (preflight) now maps its verdict to the next
 * legal harness state. These tests pin the mapping AND that every target is a legal
 * transition out of DEVELOPER_PREFLIGHT (so the wiring can never drift from TRANSITIONS).
 */
import { describe, it, expect } from 'vitest';
import { preflightVerdictToState, canTransition } from './index';

describe('preflightVerdictToState — DEVELOPER_PREFLIGHT wiring', () => {
  it('submit ⇒ SPEC_CONFORMANCE_REVIEW (observed & green ⇒ hard gate)', () => {
    expect(preflightVerdictToState('submit')).toBe('SPEC_CONFORMANCE_REVIEW');
  });

  it('self_correct ⇒ DEVELOPER_PATCH_PROPOSAL (red within budget ⇒ back to Developer)', () => {
    expect(preflightVerdictToState('self_correct')).toBe('DEVELOPER_PATCH_PROPOSAL');
  });

  it('escalate ⇒ HUMAN_GATE (budget exhausted / recurring ⇒ stop, never loop)', () => {
    expect(preflightVerdictToState('escalate')).toBe('HUMAN_GATE');
  });

  it('every mapped target is a legal transition out of DEVELOPER_PREFLIGHT', () => {
    for (const v of ['submit', 'self_correct', 'escalate'] as const) {
      expect(canTransition('DEVELOPER_PREFLIGHT', preflightVerdictToState(v))).toBe(true);
    }
  });
});
