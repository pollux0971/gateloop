import { describe, it, expect } from 'vitest';
import { decideDelegationOutcome } from './index';

describe('STORY-033.6: delegation exit-gate outcome → runtime decision (harness-core)', () => {
  it('accepted verdict ⇒ write_checkpoint', () => {
    const d = decideDelegationOutcome({ accepted: true, rejected_whole: false, out_of_write_set: [] });
    expect(d.action).toBe('write_checkpoint');
    expect(d.human_gate_reason).toBeUndefined();
  });

  it('out-of-write-set rejection ⇒ escalate_human (scope_expansion)', () => {
    const d = decideDelegationOutcome({ accepted: false, rejected_whole: true, out_of_write_set: ['evil.ts'] });
    expect(d.action).toBe('escalate_human');
    expect(d.human_gate_reason).toBe('scope_expansion');
    expect(d.reason).toMatch(/evil\.ts/);
  });

  it('gate failure within the write-set ⇒ route_debugger', () => {
    const d = decideDelegationOutcome({ accepted: false, rejected_whole: false, out_of_write_set: [] });
    expect(d.action).toBe('route_debugger');
    expect(d.human_gate_reason).toBeUndefined();
  });

  it('never auto-widens scope: an out-of-write-set change is always a human gate, never a checkpoint', () => {
    const d = decideDelegationOutcome({ accepted: false, rejected_whole: true, out_of_write_set: ['a', 'b'] });
    expect(d.action).not.toBe('write_checkpoint');
    expect(d.action).toBe('escalate_human');
  });
});
